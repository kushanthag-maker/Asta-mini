const fs = require('fs');
const path = require('path');
const config = require('../config');
const { smallCaps } = require('./font');

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

function getBody(message = {}) {
  const msg =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.documentWithCaptionMessage?.message ||
    message;
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
    const from = m.key.remoteJid;
    if (!from || from === 'status@broadcast') return;

    const body = getBody(m.message).trim();
    if (!body.startsWith(config.prefix)) return;

    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const name = (args.shift() || '').toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) return;

    const ctx = {
      sock,
      m,
      from,
      sender: m.key.participant || from,
      pushName: m.pushName || 'User',
      number,
      args,
      text: args.join(' '),
      prefix: config.prefix,
      config,
      font: smallCaps,
      commands: uniqueCommands(),
      reply: (text, opts = {}) => sock.sendMessage(from, { text, ...opts }, { quoted: m })
    };

    await cmd.run(ctx);
  } catch (e) {
    console.error('Handler error:', e);
  }
}

module.exports = { loadCommands, handleMessage, uniqueCommands };
