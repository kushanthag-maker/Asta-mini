module.exports = {
  name: 'ping',
  aliases: ['speed'],
  category: 'general',
  desc: 'check bot speed',
  async run({ sock, m, from, font }) {
    const start = Date.now();
    const sent = await sock.sendMessage(from, { text: font('pinging...') }, { quoted: m });
    const ms = Date.now() - start;
    await sock.sendMessage(from, { text: `🏓 ${font('pong')} : *${ms}ms*`, edit: sent.key });
  }
};
