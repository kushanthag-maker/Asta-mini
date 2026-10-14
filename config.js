module.exports = {
  botName: 'ASTA MINI',
  prefix: process.env.PREFIX || '.',
  mongoUri: process.env.MONGODB_URI,
  dbName: 'asta_mini',
  port: process.env.PORT || 3000,
  logo: 'https://files.catbox.moe/ghavso.webp',
  footer: 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴀsᴛᴀ ᴍɪɴɪ',

  lakvision: {
    base: process.env.LAKVISION_BASE || 'https://tobi-apisiii-production-f83b.up.railway.app/api/lakvision',
    apikey: process.env.LAKVISION_API_KEY || ''
  }
};
