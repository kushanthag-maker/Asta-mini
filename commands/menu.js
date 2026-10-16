function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

module.exports = {
  name: 'menu',
  aliases: ['help', 'cmds'],
  category: 'general',
  desc: 'show all commands',
  async run({ sock, m, from, pushName, prefix, config, font, commands }) {
    // category wise group
    const groups = {};
    for (const c of commands) {
      const cat = c.category || 'other';
      (groups[cat] = groups[cat] || []).push(c);
    }

    let text =
`╭━━〔 ${font(config.botName)} 〕━━⬣
┃ 👋 ${font('hello')} : ${pushName}
┃ ⚙️ ${font('prefix')} : ${prefix}
┃ ⏱️ ${font('uptime')} : ${formatUptime(process.uptime())}
┃ 📦 ${font('commands')} : ${commands.length}
╰━━━━━━━━━━━━━━⬣\n`;

    for (const [cat, list] of Object.entries(groups)) {
      text += `\n╭━━〔 ${font(cat)} 〕━━⬣\n`;
      for (const c of list) text += `┃ ➤ ${prefix}${c.name} ~ ${font(c.desc || '')}\n`;
      text += `╰━━━━━━━━━━━━━━⬣\n`;
    }
    text += `\n> ${config.footer}`;

    // Do not attach the logo here: Baileys needs sharp/jimp to create an
    // image thumbnail, and a missing optional image library used to make the
    // menu command log an avoidable error on Heroku. Text is reliable and
    // keeps the command responsive on low-memory dynos.
    await sock.sendMessage(from, { text }, { quoted: m });
  }
};
