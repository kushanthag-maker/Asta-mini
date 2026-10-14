const fs = require('fs');
const path = require('path');
const config = require('../config');
const { smallCaps } = require('./font');
const replies = require('./replies');

const commands = new Map();

function loadCommands() {
  commands.clear();
  const dir = path.join(__dirname, '..', 'commands');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    try {
      const cmd = require(path.join(dir, file));
      if (!cmd.name || typeof cmd.run !== 'function') continue;
      commands.set(cmd.name.toLowerCase(), cmd);
      (cmd.aliases || []).forEach(a => commands.set(a.toLowerCase(), cmd));
    } catch (e) {
      console.error(`❌ Command load failed (${file}):`, e.message);
    }
  }
  console.log(`✅ ${new Set(commands.values()).size} commands loaded`);
}

const uniqueCommands = () => [...new Set(commands.values())];

const unwrap = (message = {}) =>
  message.ephemeralMessage?.message ||
  message.viewOnceMessage?.message ||
  message.documentWithCaptionMessage?.message ||
  message;

function getBody(message = {}) {
  const msg = unwrap(message);
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ''
  );
}

// quoted (reply) message eke id eka - message type eka mokak unath hoyagannawa
function getQuotedId(message = {}) {
  const msg = unwrap(message);
  for (const v of Object.values(msg)) {
    if (v && typeof v === 'object' && v.contextInfo?.stanzaId) return v.contextInfo.stanzaId;
  }
  return null;
}

async function handleMessage(sock, m, number) {
  try {
    if (!m.message) return;
    // NOTE: remoteJid eka (PN ho @lid) wenas karanne na, reply eka yanne ekatama
    const from = m.key.remoteJid;
    if (!from || from === 'status@broadcast') return;

    const body = getBody(m.message).trim();

    const ctx = {
      sock,
      m,
      from,
      sender: m.key.participant || from,
      pushName: m.pushName || 'User',
      number,
      args: [],
      text: '',
      prefix: config.prefix,
      config,
      font: smallCaps,
      commands: uniqueCommands(),
      reply: (text, opts = {}) => sock.sendMessage(from, { text, ...opts }, { quoted: m }),
      // bot yawapu message ekakata number reply ekak balaporoththuwenna
      waitReply: (sent, handler) => {
        if (sent?.key?.id) replies.register(`${number}:${sent.key.id}`, { chat: from, handler });
      }
    };

    // 1) Number reply (quoted message eka registered nam)
    // NOTE: chat (jid) eka match karanne na - LID/PN wenas wela thibboth fail wenawa.
    // Message id eka unique nisa eka matai.
    const quotedId = getQuotedId(m.message);
    if (quotedId && body) {
      const entry = replies.get(`${number}:${quotedId}`);
      if (entry) {
        console.log(`[reply] matched quoted=${quotedId} text="${body.slice(0, 20)}"`);
        let used;
        try {
          used = await entry.handler(ctx, body);
        } catch (e) {
          console.error('Reply handler error:', e);
          await ctx.reply(`❌ ${String(e.message).replace(/apikey=[^&\s]+/gi, 'apikey=***')}`).catch(() => {});
          return;
        }
        if (used !== false) return;
      } else if (/^\d+$|^next$|^n$/i.test(body)) {
        console.log(`[reply] no pending entry for quoted=${quotedId} (expired / restart / not a bot list)`);
      }
    }

    // 2) Normal command
    if (!body.startsWith(config.prefix)) return;

    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const name = (args.shift() || '').toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) return;

    ctx.args = args;
    ctx.text = args.join(' ');
    console.log(`[cmd] ${cmd.name}`);
    await cmd.run(ctx);
  } catch (e) {
    console.error('Handler error:', e);
  }
}

module.exports = { loadCommands, handleMessage, uniqueCommands };
