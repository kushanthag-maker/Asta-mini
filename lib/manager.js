const pino = require('pino');
const config = require('../config');
const { loadBaileys } = require('./baileys');
const { getCollection } = require('./db');
const { useMongoAuthState } = require('./mongoAuth');
const { handleMessage, uniqueCommands } = require('./handler');
const { smallCaps } = require('./font');

const sessions = new Map(); // number -> { sock, status }
const starting = new Map(); // number -> Promise (eka welawata eka start ekak witharai)
const fails = new Map(); // number -> { n, first } (decrypt fail counter)
const healing = new Set();
const lastHeal = new Map();
const reconnectTimers = new Map();
let shuttingDown = false;
let baileysVersion;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mask = jid => String(jid || '?').replace(/^(\d{3})\d+(\d{2})/, '$1***$2');


// ---------- Signal session self-healing ----------
// "No matching sessions found" / "Bad MAC" / invalid pre-keys = phone ekai bot ekai athara
// Signal session eka desync. Eka godak welawata wadi unoth session keys and pre-keys
// (session-*, sender-key-*, pre-key-*) Mongo eken clear karala
// socket eka aye start karanawa. Credentials wenas wenne na, e nisa re-pair karanna oni na.
const FAIL_LIMIT = 4;            // soththuwama 60s athare mekata wada fail unoth
const HEAL_COOLDOWN = 5 * 60000; // minute 5kata parak witharai

async function clearSignalKeys(number) {
  const r = await getCollection().deleteMany({ sessionId: number, key: { $regex: '^(session-|sender-key|pre-key-)' } });
  return r.deletedCount;
}

function onDecryptFail(number) {
  const now = Date.now();
  const f = fails.get(number) || { n: 0, first: now };
  if (now - f.first > 60000) { f.n = 0; f.first = now; }
  f.n++;
  fails.set(number, f);
  if (f.n >= FAIL_LIMIT && !healing.has(number) && now - (lastHeal.get(number) || 0) > HEAL_COOLDOWN) {
    healSessions(number).catch(e => console.error('Heal error:', e.message));
  }
}

async function healSessions(number) {
  healing.add(number);
  lastHeal.set(number, Date.now());
  fails.delete(number);
  try {
    console.log(`🩺 [${mask(number)}] repeated decrypt failures -> clearing Signal sessions & reconnecting`);
    const s = sessions.get(number);
    if (s) {
      sessions.delete(number);
      try { s.sock.end(undefined); } catch {}
    }
    await sleep(2000); // queue wela thibba writes iwara wenna
    const n = await clearSignalKeys(number);
    console.log(`🩺 [${mask(number)}] cleared ${n} signal key(s)`);
    await sleep(1000);
    if (!shuttingDown) await startSession(number);
  } finally {
    healing.delete(number);
  }
}

// RESET_SIGNAL_SESSIONS=<any value> set karala deploy karoth, eka value ekata parak witharai
// okkoma numbers walata signal sessions clear wenawa (value eka wenas karoth aye run wenawa)
async function maybeResetSignal() {
  const full = process.env.RESET_ALL_AUTH;
  if (full) {
    const col = getCollection();
    const flag = await col.findOne({ _id: 'meta:full-auth-reset' });
    if (flag?.value !== full) {
      const r = await col.deleteMany({});
      await col.replaceOne(
        { _id: 'meta:full-auth-reset' },
        { _id: 'meta:full-auth-reset', key: 'meta', value: full },
        { upsert: true }
      );
      console.log(`🧹 FULL auth reset completed (${r.deletedCount} Mongo records). Fresh pairing is required.`);
    }
    return;
  }
  const v = process.env.RESET_SIGNAL_SESSIONS;
  if (!v) return;
  const col = getCollection();
  const flag = await col.findOne({ _id: 'meta:signal-reset' });
  if (flag?.value === v) return;
  const r = await col.deleteMany({ key: { $regex: '^(session-|sender-key|pre-key-)' } });
  await col.replaceOne({ _id: 'meta:signal-reset' }, { _id: 'meta:signal-reset', key: 'meta', value: v }, { upsert: true });
  console.log(`🧹 Signal sessions cleared (${r.deletedCount} keys) for RESET_SIGNAL_SESSIONS=${v}`);
}

// per-number logger: decrypt failures count karanna hook ekak thiyenawa
function makeLogger(number) {
  return pino({
    level: process.env.LOG_LEVEL || 'warn', // wedi detail ona nam: heroku config:set LOG_LEVEL=info
    hooks: {
      logMethod(args, method) {
        try {
          const o = args[0];
          const msg = typeof o === 'object' ? args[1] || o?.msg : o;
          const jid = o?.key?.remoteJid;
          const groupOrStatus = String(jid || '').endsWith('@g.us') || jid === 'status@broadcast';
          // Group history can contain messages encrypted with devices the bot
          // never had a session for. Do not let that normal group noise reset
          // healthy one-to-one sessions.
          if (!groupOrStatus && msg === 'failed to decrypt message' && /No matching sessions|No session record|Bad MAC|No session found|Invalid PreKey ID/i.test(String(o?.err?.message || ''))) {
            onDecryptFail(number);
          }
        } catch {}
        return method.apply(this, args);
      }
    }
  });
}

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

// Baileys error objects are not always Boom instances. Depending on the
// version/transport, the status code may be in output, data, or directly on
// the error. Reading only output.statusCode makes normal disconnects look like
// an unknown/logout case and can leave the bot offline.
function disconnectReason(lastDisconnect) {
  const error = lastDisconnect?.error;
  return error?.output?.statusCode ?? error?.data?.statusCode ?? error?.statusCode;
}

function scheduleReconnect(number) {
  if (shuttingDown || reconnectTimers.has(number)) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(number);
    if (shuttingDown) return;
    sessions.set(number, { sock: null, status: 'connecting' });
    startSession(number).catch(e => {
      console.error(`Reconnect fail ${mask(number)}:`, e.message);
      scheduleReconnect(number);
    });
  }, 3000);
  timer.unref?.();
  reconnectTimers.set(number, timer);
}

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

  try {
    await sock.sendMessage(jid, { image: { url: config.logo }, caption });
  } catch (e) {
    console.error('Welcome image failed, sending text fallback:', e.message);
    await sock.sendMessage(jid, { text: caption });
  }
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

  const logger = makeLogger(number);
  const { state, saveCreds } = await useMongoAuthState(getCollection(), number);
  if (!baileysVersion) ({ version: baileysVersion } = await fetchLatestBaileysVersion());

  const sock = makeWASocket({
    version: baileysVersion,
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
    for (const m of messages) {
      // Do not let one command rejection become an unhandled promise. Keep
      // processing independent incoming messages without blocking the event.
      void handleMessage(sock, m, number).catch(e =>
        console.error(`[${mask(number)}] message handling failed:`, e.message)
      );
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    const entry = sessions.get(number);
    if (!entry || entry.sock !== sock) return; // stale socket

    if (connection === 'open') {
      entry.status = 'open';
      console.log(`✅ [${mask(number)}] connected`);
      // Welcome media can be slow. It must not hold the connection-update
      // handler open while commands are already allowed to run.
      void sendWelcome(sock, number).catch(e => console.error('Welcome error:', e.message));
    }

    if (connection === 'close') {
      const reason = disconnectReason(lastDisconnect);
      console.log(`⚠️ [${mask(number)}] closed (${reason}) ${lastDisconnect?.error?.message || ''}`);
      sessions.delete(number);
      if (shuttingDown) return;

      if (reason === DisconnectReason.loggedOut) {
        await removeSession(number);
      } else if (reason === DisconnectReason.connectionReplaced) {
        // wena instance ekak (local / Termux / old dyno) same session eka use karanawa - fight karanna epa
        console.log(`⚠️ [${mask(number)}] session replaced by another instance, not reconnecting`);
      } else if (state.creds.registered || reason === DisconnectReason.restartRequired) {
        scheduleReconnect(number);
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
  if (getStatus(number) === 'open') throw new Error('This number is already connected');
  if (starting.has(number) || getStatus(number) === 'connecting') throw new Error('Pairing is already in progress for this number');
  await removeSession(number); // explicit fresh pairing clears previous saved auth for this number
  return startSession(number, true);
}

async function restoreAll() {
  await maybeResetSignal();
  const docs = await getCollection().find({ key: 'creds' }).project({ sessionId: 1 }).toArray();
  console.log(`🔄 Restoring ${docs.length} session(s)...`);
  for (const d of docs) {
    try { await startSession(d.sessionId); } catch (e) { console.error(`Restore fail ${d.sessionId}:`, e.message); }
    await sleep(300);
  }
}

// Heroku SIGTERM: sockets close karala Mongo writes iwara wenna thappara 2k inna
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  console.log('🛑 Shutting down, closing sessions...');
  const active = [...sessions.values()];
  sessions.clear();
  for (const s of active) {
    try { s.sock.ev.removeAllListeners(); s.sock.end(undefined); } catch {}
  }
  await sleep(1000);
}

module.exports = { pair, restoreAll, count, getStatus, shutdown };
