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

function unwrap(message = {}) {
  let current = message;
  // WhatsApp can nest these wrappers more than one level deep. A single
  // unwrap made some view-once/edited messages look like empty messages.
  for (let i = 0; i < 5; i++) {
    const next =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message;
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

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

function getQuotedId(message = {}) {
  const msg = unwrap(message);
  for (const v of Object.values(msg)) {
    if (v && typeof v === 'object' && v.contextInfo?.stanzaId) {
      return v.contextInfo.stanzaId;
    }
  }
  return null;
}

async function handleMessage(sock, m, number) {
  try {
    if (!m.message) return;

    const from = m.key.remoteJid;
    if (!from || from === 'status@broadcast') return;

    // Newsletter messages ignore
    if (from.endsWith('@newsletter')) return;

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
      waitReply: (sent, handler) => {
        if (sent?.key?.id) {
          replies.register(`${number}:${sent.key.id}`, { chat: from, handler });
        }
      }
    };

    // 1) Number reply (quoted message)
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
      } else if (/^(\d+|next|n)$/i.test(body)) {
        console.log(`[reply] no pending entry for quoted=${quotedId}`);
      }
    }

    // 2) Normal command
    if (!config.prefix || !body.startsWith(config.prefix)) return;

    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const name = (args.shift() || '').toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) return;

    ctx.args = args;
    ctx.text = args.join(' ');
    console.log(`[cmd] ${cmd.name}`);
    try {
      await cmd.run(ctx);
    } catch (e) {
      const safe = String(e?.message || e || 'Unknown command error')
        .replace(/apikey=[^&\s]+/gi, 'apikey=***')
        .slice(0, 300);
      console.error(`[cmd] ${cmd.name} failed:`, e?.stack || e);
      await ctx.reply(`❌ ${cmd.name} failed\n${safe}`).catch(() => {});
    }
  } catch (e) {
    console.error('Handler error:', e);
  }
}

module.exports = { loadCommands, handleMessage, uniqueCommands };
