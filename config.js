module.exports = {
  botName: process.env.BOT_NAME || 'ASTA MINI',
  prefix: process.env.PREFIX || '.',
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB || 'asta_mini',
  port: Number(process.env.PORT || 3000),
  logo: process.env.BOT_LOGO || 'https://files.catbox.moe/ghavso.webp',
  footer: process.env.BOT_FOOTER || 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴀsᴛᴀ ᴍɪɴɪ'
};
