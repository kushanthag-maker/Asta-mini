const { Readable } = require('stream');

// TikTok API (private) - key eka methanama
const BASE = 'https://tobi-apisiii-production.up.railway.app/api/tiktok/download';
const KEY = process.env.TIKTOK_API_KEY;

const MAX_VIDEO = 50 * 1024 ** 2; // me size eken udata nam document widiyata yawanawa
const MAX_BYTES = 1.9 * 1024 ** 3; // WhatsApp limit ~2GB
const TT_REGEX = /https?:\/\/(?:[\w-]+\.)?tiktok\.com\/[^\s]+/i;

const clean = s => String(s || '').replace(/apikey=[^&\s]+/gi, 'apikey=***'); // key leak wenna epa
const fmtSize = b => (b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB');

// link eka message eke ho reply karapu message eke hoyagannawa
function findUrl(c) {
  const direct = (c.text || '').match(TT_REGEX);
  if (direct) return direct[0];

  const msg = c.m.message || {};
  const inner = msg.ephemeralMessage?.message || msg;
  const quoted = inner.extendedTextMessage?.contextInfo?.quotedMessage;
  const qt = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
  return (qt.match(TT_REGEX) || [])[0] || null;
}

module.exports = {
  name: 'tt',
  aliases: ['tiktok', 'ttdl'],
  category: 'download',
  desc: 'download tiktok video (no watermark)',
  async run(c) {
    const link = findUrl(c);
    if (!link) {
      return c.reply(`📌 ${c.font('usage')} : ${c.prefix}tt <tiktok-video-url>`);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000); // headers enakan witharai timeout
    let source;

    try {
      if (!KEY) throw new Error('TIKTOK_API_KEY is not configured');
      const url = new URL(BASE);
      url.searchParams.set('url', link);
      url.searchParams.set('format', 'nowatermark');
      url.searchParams.set('apikey', KEY);

      await c.reply(`⏳ ${c.font('downloading tiktok video...')}`);

      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      clearTimeout(timer);

      const type = (res.headers.get('content-type') || '').toLowerCase();
      const isFile = res.ok && !type.includes('json') && !type.includes('html') && !type.startsWith('text/');

      if (!isFile) {
        const body = await res.text().catch(() => '');
        let msg = body;
        try { const j = JSON.parse(body); msg = j.error || j.message || body; } catch {}
        throw new Error(`${res.status} ${String(msg).replace(/\s+/g, ' ').slice(0, 200)}`);
      }

      const size = Number(res.headers.get('content-length') || 0);
      if (size > MAX_BYTES) throw new Error(`File eka loku wadi (${fmtSize(size)})`);

      const caption = `🎵 ${c.font('tiktok downloader')}${size ? `\n📦 ${fmtSize(size)}` : ''}\n\n> ${c.config.footer}`;
      const asDoc = size > MAX_VIDEO;

      // response body eka STREAM karala Baileys ekata denawa (RAM ekata full file eka load wenne na)
      source = Readable.fromWeb(res.body);
      await c.sock.sendMessage(
        c.from,
        asDoc
          ? { document: { stream: source }, mimetype: 'video/mp4', fileName: `tiktok-${Date.now()}.mp4`, caption }
          : { video: { stream: source }, mimetype: 'video/mp4', caption },
        { quoted: c.m }
      );
    } catch (e) {
      clearTimeout(timer);
      console.error('TikTok error:', clean(e.stack || e.message));
      await c.reply(`❌ ${c.font('tiktok download failed')}\n${clean(e.message).slice(0, 300)}`);
    } finally {
      try { source?.destroy(); } catch {}
      try { ac.abort(); } catch {}
    }
  }
};
