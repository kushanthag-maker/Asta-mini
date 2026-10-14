const NORMAL = 'abcdefghijklmnopqrstuvwxyz'.split('');
const SMALL = Array.from('ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ');

// "Lidarz" -> "ʟɪᴅᴀʀᴢ"
function smallCaps(text = '') {
  return Array.from(String(text)).map(ch => {
    const i = NORMAL.indexOf(ch.toLowerCase());
    return i === -1 ? ch : SMALL[i];
  }).join('');
}

module.exports = { smallCaps };
