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
    const quotedId = unwrap(m.message).extendedTextMessage?.contextInfo?.stanzaId;
    if (quotedId && body) {
      const entry = replies.get(`${number}:${quotedId}`);
      if (entry && entry.chat === from) {
        const used = await entry.handler(ctx, body);
        if (used !== false) return;
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
    await cmd.run(ctx);
  } catch (e) {
    console.error('Handler error:', e);
  }
}

module.exports = { loadCommands, handleMessage, uniqueCommands };
