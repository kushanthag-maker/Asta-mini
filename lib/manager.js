const pino = require('pino');
const config = require('../config');
const { loadBaileys } = require('./baileys');
const { getCollection } = require('./db');
const { useMongoAuthState } = require('./mongoAuth');
const { handleMessage, uniqueCommands } = require('./handler');
const { smallCaps } = require('./font');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sessions = new Map();
const starting = new Map();
let shuttingDown = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mask = (jid) => {
  const s = String(jid || '?');
  return s.replace(/^(\d{3})\d+(\d{2})/, '$1***$2');
};

const msgStore = new Map();
function storeMsg(msg) {
  if (!msg?.key?.id || !msg.message) return;
  msgStore.set(msg.key.id, msg.message);
  if (msgStore.size > 3000) {
    const firstKey = msgStore.keys().next().value;
    msgStore.delete(firstKey);
  }
}

function createRetryCache() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
      const t = setTimeout(() => map.delete(k), 5 * 60 * 1000);
      if (t.unref) t.unref();
    },
    del: (k) => map.delete(k),
    flushAll: () => map.clear()
  };
}

const count = () => [...sessions.values()].filter(s => s.status === 'open').length;
const getStatus = (number) => sessions.get(number)?.status || 'none';

async function removeSession(number) {
  const s = sessions.get(number);
  if (s) {
    sessions.delete(number);
    try {
      s.sock.ev.removeAllListeners();
      s.sock.end(undefined);
    } catch (e) {}
  }
  try {
    await getCollection().deleteMany({ sessionId: number });
  } catch (e) {}
}

async function sendWelcome(sock, number) {
  const col = getCollection();
  const flagId = number + ':welcomed';
  if (await col.findOne({ _id: flagId })) return;

  const { jidNormalizedUser } = await loadBaileys();
  await sleep(3000);
  const jid = jidNormalizedUser(sock.user.id);

  const caption = '╭━━〔 ' + smallCaps(config.botName) + ' 〕━━⬣\n' +
    '┃ ✅ ' + smallCaps('connected successfully') + '\n' +
    '┃ 👤 ' + smallCaps('number') + ' : ' + number + '\n' +
    '┃ ⚙️ ' + smallCaps('prefix') + ' : ' + config.prefix + '\n' +
    '┃ 📦 ' + smallCaps('commands') + ' : ' + uniqueCommands().length + '\n' +
    '╰━━━━━━━━━━━━━━⬣\n\n' +
    smallCaps('type') + ' ' + config.prefix + 'menu ' + smallCaps('to see all commands') + '\n\n' +
    '> ' + config.footer;

  await sock.sendMessage(jid, { image: { url: config.logo }, caption });
  await col.replaceOne(
    { _id: flagId },
    { _id: flagId, sessionId: number, key: 'welcomed' },
    { upsert: true }
  );
}

async function _startSession(number, wantCode) {
  if (wantCode === undefined) wantCode = false;

  const baileys = await loadBaileys();
  const makeWASocket = baileys.makeWASocket;
  const DisconnectReason = baileys.DisconnectReason;
  const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  const makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
  const Browsers = baileys.Browsers;

  const old = sessions.get(number);
  if (old) {
    sessions.delete(number);
    try {
      old.sock.ev.removeAllListeners();
      old.sock.end(undefined);
    } catch (e) {}
  }

  const auth = await useMongoAuthState(getCollection(), number);
  const state = auth.state;
  const saveCreds = auth.saveCreds;

  const versionInfo = await fetchLatestBaileysVersion();
  const version = versionInfo.version;

  const sock = makeWASocket({
    version: version,
    logger: logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    msgRetryCounterCache: createRetryCache(),
    getMessage: async (key) => {
      return msgStore.get(key.id) || undefined;
    }
  });

  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async function () {
    const args = arguments;
    try {
      let res;
      try {
        res = await origSend.apply(sock, args);
      } catch (e) {
        if (!args[2] || !args[2].quoted) throw e;
        console.error('[out] quoted send failed (' + e.message + '), retrying without quote');
        const opts = Object.assign({}, args[2]);
        delete opts.quoted;
        res = await origSend.call(sock, args[0], args[1], opts);
      }
      storeMsg(res);
      console.log('[out] to=' + mask(args[0]) + ' id=' + (res && res.key ? res.key.id : 'unknown'));
      return res;
    } catch (e) {
      console.error('[out] FAILED to=' + mask(args[0]) + ': ' + e.message);
      throw e;
    }
  };

  sessions.set(number, { sock: sock, status: 'connecting' });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', function (upsert) {
    const messages = upsert.messages;
    const type = upsert.type;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      storeMsg(m);
      if (type === 'notify') {
        const jid = (m.key && m.key.remoteJid) ? m.key.remoteJid : '?';
        const fromMe = !!(m.key && m.key.fromMe);
        const status = m.message ? 'ok' : ('NO-CONTENT stub=' + (m.messageStubType != null ? m.messageStubType : '-'));
        console.log('[in] ' + mask(jid) + ' fromMe=' + fromMe + ' ' + status);
      }
    }

    if (type !== 'notify') return;

    for (let i = 0; i < messages.length; i++) {
      handleMessage(sock, messages[i], number);
    }
  });

  sock.ev.on('connection.update', async function (update) {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;

    const entry = sessions.get(number);
    if (!entry || entry.sock !== sock) return;

    if (connection === 'open') {
      entry.status = 'open';
      console.log('✅ [' + mask(number) + '] connected');
      try {
        await sendWelcome(sock, number);
      } catch (e) {
        console.error('Welcome error:', e.message);
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;

      console.log('⚠️ [' + mask(number) + '] closed (' + reason + ') ' +
        (lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : ''));

      sessions.delete(number);
      if (shuttingDown) return;

      if (reason === DisconnectReason.loggedOut) {
        await removeSession(number);
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log('⚠️ [' + mask(number) + '] session replaced by another instance, not reconnecting');
      } else if (state.creds.registered || reason === DisconnectReason.restartRequired) {
        setTimeout(function () {
          startSession(number).catch(function (e) {
            console.error('Reconnect fail:', e.message);
          });
        }, 5000);
      } else {
        await removeSession(number);
      }
    }
  });

  let code = null;
  if (wantCode && !state.creds.registered) {
    await sleep(2500);
    code = await sock.requestPairingCode(number);
    if (code) {
      code = code.match(/.{1,4}/g).join('-');
    }
  }
  return code;
}

function startSession(number, wantCode) {
  if (wantCode === undefined) wantCode = false;
  const prev = starting.get(number) || Promise.resolve();
  const run = prev.catch(function () {}).then(function () {
    return _startSession(number, wantCode);
  });
  starting.set(number, run);
  run.catch(function () {}).finally(function () {
    if (starting.get(number) === run) starting.delete(number);
  });
  return run;
}

async function pair(number) {
  if (getStatus(number) === 'open') {
    throw new Error('Me number eka already connected!');
  }
  await removeSession(number);
  return startSession(number, true);
}

async function restoreAll() {
  const docs = await getCollection().find({ key: 'creds' }).project({ sessionId: 1 }).toArray();
  console.log('🔄 Restoring ' + docs.length + ' session(s)...');
  for (let i = 0; i < docs.length; i++) {
    try {
      await startSession(docs[i].sessionId);
    } catch (e) {
      console.error('Restore fail ' + docs[i].sessionId + ':', e.message);
    }
    await sleep(2000);
  }
}

async function shutdown() {
  shuttingDown = true;
  console.log('🛑 Shutting down, closing sessions...');
  for (const entry of sessions.values()) {
    try {
      entry.sock.end(undefined);
    } catch (e) {}
  }
  await sleep(2000);
}

module.exports = {
  pair: pair,
  restoreAll: restoreAll,
  count: count,
  getStatus: getStatus,
  shutdown: shutdown
};
