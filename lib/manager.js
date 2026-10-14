const pino = require('pino');
const config = require('../config');
const { loadBaileys } = require('./baileys');
const { getCollection } = require('./db');
const { useMongoAuthState } = require('./mongoAuth');
const { handleMessage, uniqueCommands } = require('./handler');
const { smallCaps } = require('./font');

// warn level: decrypt failures / Bad MAC wage errors Heroku logs wala pennanawa
// (wedi detail ona nam: heroku config:set LOG_LEVEL=info)
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sessions = new Map(); // number -> { sock, status }
const starting = new Map(); // number -> Promise (eka welawata eka start ekak witharai)
let shuttingDown = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mask = jid => String(jid || '?').replace(/^(\d{3})\d+(\d{2})/, '$1***$2');

// ---- yawana messages store (retry walata getMessage) ----
const msgStore = new Map();
function storeMsg(msg) {
  if (!msg?.key?.id || !msg.message) return;
  msgStore.set(msg.key.id, msg.message);
  if (msgStore.size > 3000) msgStore.delete(msgStore.keys().next().value);
}

// ---- retry counter cache ----
function createRetryCache() {
  const map = new Map();
  return {
    get: k => map.get(k),
    set: (k, v) => {
      map.set(k, v);
      const t = setTimeout(() => map.delete(k), 5 * 60 * 1000);
      t.unref?.();
    },
    del: k => map.delete(k),
    flushAll: () => map.clear()
  };
}

const count = () => [...sessions.values()].filter(s => s.status === 'open').length;
const getStatus = number => sessions.get(number)?.status || 'none';

async function removeSession(number) {
  const s = sessions.get(number);
  if (s) {
    sessions.delete(number);
    try { s.sock.ev.removeAllListeners(); s.sock.end(undefined); } catch {}
  }
  await getCollection().deleteMany({ sessionId: number });
}

async function sendWelcome(sock, number) {
  const col = getCollection();
  const flagId = `${number}:welcomed`;
  if (await col.findOne({ _id: flagId })) return;

  const { jidNormalizedUser } = await loadBaileys();
  await sleep(3000); // keys / lid mapping sync wenna poddak inna
  const jid = jidNormalizedUser(sock.user.id);
  const caption =
`╭━━〔 ${smallCaps(config.botName)} 〕━━⬣
┃ ✅ ${smallCaps('connected successfully')}
┃ 👤 ${smallCaps('number')} : ${number}
┃ ⚙️ ${smallCaps('prefix')} : ${config.prefix}
┃ 📦 ${smallCaps('commands')} : ${uniqueCommands().length}
╰━━━━━━━━━━━━━━⬣

${smallCaps('type')} ${config.prefix}menu ${smallCaps('to see all commands')}

> ${config.footer}`;

  await sock.sendMessage(jid, { image: { url: config.logo }, caption });
  await col.replaceOne({ _id: flagId }, { _id: flagId, sessionId: number, key: 'welcomed' }, { upsert: true });
}

async function _startSession(number, wantCode = false) {
  const {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
  } = await loadBaileys();

  // duplicate socket ekak thiyenawanam clean karanna
  const old = sessions.get(number);
  if (old) {
    sessions.delete(number);
    try { old.sock.ev.removeAllListeners(); old.sock.end(undefined); } catch {}
  }

  const { state, saveCreds } = await useMongoAuthState(getCollection(), number);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    msgRetryCounterCache: createRetryCache(),
    getMessage: async key => msgStore.get(key.id) || undefined
  });

  // yawana okkoma message store karanawa (retry walata) + fail unoth log karanawa
  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    try {
      let res;
      try {
        res = await origSend(...args);
      } catch (e) {
        // quote karanna bari unoth quote nathuwa aye yawanawa
        if (!args[2]?.quoted) throw e;
        console.error(`[out] quoted send failed (${e.message}), retrying without quote`);
        const { quoted, ...rest } = args[2];
        res = await origSend(args[0], args[1], rest);
      }
      storeMsg(res);
      console.log(`[out] to=${mask(args[0])} id=${res?.key?.id}`);
      return res;
    } catch (e) {
      console.error(`[out] FAILED to=${mask(args[0])}: ${e.message}`);
      throw e;
    }
  };

  sessions.set(number, { sock, status: 'connecting' });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) {
      storeMsg(m);
      if (type === 'notify') {
        // NO-CONTENT = message eka decrypt wela na (Bad MAC / session aula)
        console.log(
          `[in] ${mask(m.key.remoteJid)} fromMe=${!!m.key.fromMe} ` +
          (m.message ? 'ok' : `NO-CONTENT stub=${m.messageStubType ?? '-'}`)
        );
      }
    }
    if (type !== 'notify') return;
    for (const m of messages) handleMessage(sock, m, number);
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    const entry = sessions.get(number);
    if (!entry || entry.sock !== sock) return; // stale socket

    if (connection === 'open') {
      entry.status = 'open';
      console.log(`✅ [${mask(number)}] connected`);
      try { await sendWelcome(sock, number); } catch (e) { console.error('Welcome error:', e.message); }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ [${mask(number)}] closed (${reason}) ${lastDisconnect?.error?.message || ''}`);
      sessions.delete(number);
      if (shuttingDown) return;

      if (reason === DisconnectReason.loggedOut) {
        await removeSession(number);
      } else if (reason === DisconnectReason.connectionReplaced) {
        // wena instance ekak (local / Termux / old dyno) same session eka use karanawa - fight karanna epa
        console.log(`⚠️ [${mask(number)}] session replaced by another instance, not reconnecting`);
      } else if (state.creds.registered || reason === DisconnectReason.restartRequired) {
        setTimeout(() => startSession(number).catch(e => console.error('Reconnect fail:', e.message)), 3000);
      } else {
        await removeSession(number); // pairing eka complete una nathnam clean
      }
    }
  });

  let code = null;
  if (wantCode && !state.creds.registered) {
    await sleep(2500);
    code = await sock.requestPairingCode(number);
    code = code?.match(/.{1,4}/g)?.join('-') || code;
  }
  return code;
}

// same number ekata start ekak witharak welawata run wenna (duplicate socket nathuwa)
function startSession(number, wantCode = false) {
  const prev = starting.get(number) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => _startSession(number, wantCode));
  starting.set(number, run);
  run.catch(() => {}).finally(() => {
    if (starting.get(number) === run) starting.delete(number);
  });
  return run;
}

async function pair(number) {
  if (getStatus(number) === 'open') throw new Error('Me number eka already connected!');
  await removeSession(number); // fresh pairing
  return startSession(number, true);
}

async function restoreAll() {
  const docs = await getCollection().find({ key: 'creds' }).project({ sessionId: 1 }).toArray();
  console.log(`🔄 Restoring ${docs.length} session(s)...`);
  for (const d of docs) {
    try { await startSession(d.sessionId); } catch (e) { console.error(`Restore fail ${d.sessionId}:`, e.message); }
    await sleep(1500);
  }
}

// Heroku SIGTERM: sockets close karala Mongo writes iwara wenna thappara 2k inna
async function shutdown() {
  shuttingDown = true;
  console.log('🛑 Shutting down, closing sessions...');
  for (const [, s] of sessions) {
    try { s.sock.end(undefined); } catch {}
  }
  await sleep(2000);
}

module.exports = { pair, restoreAll, count, getStatus, shutdown };
