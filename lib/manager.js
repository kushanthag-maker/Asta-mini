const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('../config');
const { getCollection } = require('./db');
const { useMongoAuthState } = require('./mongoAuth');
const { handleMessage, uniqueCommands } = require('./handler');
const { smallCaps } = require('./font');

const makeWASocket = baileys.default || baileys;
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  delay,
  jidNormalizedUser
} = baileys;

const logger = pino({ level: 'silent' });
const sessions = new Map(); // number -> { sock, status }

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

async function startSession(number, wantCode = false) {
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
    syncFullHistory: false
  });

  sessions.set(number, { sock, status: 'connecting' });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) handleMessage(sock, m, number);
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    const entry = sessions.get(number);
    if (!entry || entry.sock !== sock) return; // stale socket

    if (connection === 'open') {
      entry.status = 'open';
      console.log(`✅ [${number}] connected`);
      try { await sendWelcome(sock, number); } catch (e) { console.error('Welcome error:', e.message); }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ [${number}] closed (${reason})`);
      sessions.delete(number);

      if (reason === DisconnectReason.loggedOut) {
        await removeSession(number);
      } else if (state.creds.registered || reason === DisconnectReason.restartRequired) {
        setTimeout(() => startSession(number).catch(e => console.error('Reconnect fail:', e.message)), 3000);
      } else {
        await removeSession(number); // pairing eka complete una nathnam clean
      }
    }
  });

  let code = null;
  if (wantCode && !state.creds.registered) {
    await delay(2500);
    code = await sock.requestPairingCode(number);
    code = code?.match(/.{1,4}/g)?.join('-') || code;
  }
  return code;
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
    await delay(1500);
  }
}

module.exports = { pair, restoreAll, count, getStatus };
