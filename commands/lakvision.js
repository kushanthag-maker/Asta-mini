const { Readable } = require('stream');

// LakVision API (private) - key eka methanama
const BASE = 'https://tobi-apisiii-production-f83b.up.railway.app/api/lakvision';
const KEY = process.env.LAKVISION_API_KEY;

const busy = new Set(); // number -> eka welawata download ekak witharai
const MAX_BYTES = 1.9 * 1024 ** 3; // WhatsApp document limit ~2GB

const https = u => (u || '').replace(/^http:\/\//i, 'https://');
const clean = s => String(s || '').replace(/apikey=[^&\s]+/gi, 'apikey=***'); // key leak wenna epa
const trim = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fileSafe = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

async function api(endpoint, params = {}) {
  if (!KEY) throw new Error('LAKVISION_API_KEY is not configured');
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, apikey: KEY })) url.searchParams.set(k, v);

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    throw new Error(json?.error || json?.message || `API error (${res.status})`);
  }
  return json;
}

// ---------- 1) SEARCH ----------
async function showSearch(c, query, page = 1) {
  const data = await api('search', { q: query, page });
  const results = (data.results || []).slice(0, 15);
  if (!results.length) return c.reply(`❌ ${c.font('no results for')} "${query}"`);

  let text =
`╭━━〔 ${c.font('lakvision search')} 〕━━⬣
┃ 🔎 ${c.font('query')} : ${query}
┃ 📄 ${c.font('page')} : ${data.page || page}/${data.maxPage || 1}
╰━━━━━━━━━━━━━━⬣\n\n`;

  results.forEach((r, i) => {
    text += `*${i + 1}* ➤ ${trim(r.title || 'Untitled')}\n`;
  });
  text += `\n↩️ ${c.font('reply with a number to get info')}`;
  if (data.hasNext) text += `\n➡️ ${c.font('reply')} *next* ${c.font('for next page')}`;
  text += `\n\n> ${c.config.footer}`;

  const sent = await c.reply(text);

  c.waitReply(sent, async (c2, input) => {
    const t = input.trim().toLowerCase();

    if ((t === 'next' || t === 'n') && data.hasNext) {
      await showSearch(c2, query, page + 1).catch(e => c2.reply(`❌ ${clean(e.message)}`));
      return true;
    }
    if (!/^\d+$/.test(t)) return false;

    const n = parseInt(t, 10);
    if (n < 1 || n > results.length) {
      await c2.reply(`❌ 1 - ${results.length} athara number ekak danna`);
      return true;
    }
    await showInfo(c2, results[n - 1]).catch(e => c2.reply(`❌ ${clean(e.message)}`));
    return true;
  });
}

// ---------- 2) INFO + QUALITY ----------
async function showInfo(c, item) {
  const { data } = await api('info', { id: item.id });

  const streams = (data.streams || [])
    .filter(s => s.directDownloadUrl || s.downloadUrl)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const title = data.title || item.title || 'Unknown';
  const poster = data.poster || item.thumb || '';

  if (!streams.length) {
    return c.reply(
      `❌ ${c.font('no downloadable stream for this one')}\n\n🎬 ${title}\n🔗 ${data.videoUrl || item.watchUrl || ''}`
    );
  }

  let caption =
`╭━━〔 ${c.font('lakvision info')} 〕━━⬣
┃ 🎬 ${title}
┃ 🆔 ${data.id} • ${data.source || item.source || '-'}
┃ 📺 ${streams.map(s => s.quality).join(' | ')}
╰━━━━━━━━━━━━━━⬣\n\n`;

  streams.forEach((s, i) => {
    caption += `*${i + 1}* ➤ ${s.quality} (${s.format || 'MP4'})\n`;
  });
  caption += `\n↩️ ${c.font('reply with a number to download')}\n\n> ${c.config.footer}`;

  let sent;
  try {
    if (!poster) throw new Error('no poster');
    sent = await c.sock.sendMessage(c.from, { image: { url: https(poster) }, caption }, { quoted: c.m });
  } catch {
    sent = await c.reply(caption); // poster nathnam / fail unoth text witharak
  }

  c.waitReply(sent, async (c2, input) => {
    const t = input.trim();
    if (!/^\d+$/.test(t)) return false;

    const n = parseInt(t, 10);
    if (n < 1 || n > streams.length) {
      await c2.reply(`❌ 1 - ${streams.length} athara number ekak danna`);
      return true;
    }
    await download(c2, data, title, streams[n - 1]);
    return true;
  });
}

// ---------- 3) DOWNLOAD (stream -> WhatsApp document) ----------
const fmtSize = b => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB');

// URLs list eken mulinma wada karana eka open karanawa (body eka read karanne na)
async function openFirst(urls) {
  const errors = [];
  for (const u of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000); // headers enakan witharai timeout
    try {
      const res = await fetch(u, { signal: ac.signal, redirect: 'follow' });
      clearTimeout(timer);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const isFile = res.ok && !type.includes('json') && !type.includes('html') && !type.startsWith('text/');
      if (isFile) return { res, ac };

      const body = await res.text().catch(() => '');
      errors.push(`${res.status} ${body.replace(/\s+/g, ' ').slice(0, 150)}`);
      ac.abort();
    } catch (e) {
      clearTimeout(timer);
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(' | '));
}

async function download(c, data, title, stream) {
  if (busy.has(c.number)) {
    return c.reply(`⏳ ${c.font('another download is running, please wait')}`);
  }
  busy.add(c.number);

  let opened;
  let source;
  try {
    const q = parseInt(stream.quality, 10);
    const urls = [
      https(stream.directDownloadUrl),
      `${BASE}/download?id=${data.id}&resolution=${q}&direct=true&apikey=${KEY}`,
      https(stream.streamUrl)
    ].filter((u, i, a) => u && a.indexOf(u) === i);

    opened = await openFirst(urls);
    const { res } = opened;

    const size = Number(res.headers.get('content-length') || 0);
    if (size > MAX_BYTES) {
      return c.reply(
        `❌ ${c.font('file is too big for whatsapp')} (${fmtSize(size)})\n` +
        `${c.font('try a lower quality')} (720p / 480p)`
      );
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    const disp = res.headers.get('content-disposition') || '';
    const extFromDisp = (disp.match(/filename\*?=(?:UTF-8'')?"?[^";]*\.(\w{2,4})"?/i) || [])[1];
    const ext = (extFromDisp || (/matroska|mkv/.test(type) || String(stream.format).toLowerCase() === 'mkv' ? 'mkv' : 'mp4')).toLowerCase();
    const mimetype = type.startsWith('video/') ? type.split(';')[0] : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    const fileName = `${fileSafe(title)} [${stream.quality}].${ext}`;

    await c.reply(
      `⬇️ ${c.font('downloading')} *${stream.quality}*${size ? ` (${fmtSize(size)})` : ''} ...\n` +
      `${c.font('big files take a few minutes, please wait')}`
    );

    // API response body eka STREAM ekak widiyata Baileys ekata denawa.
    // Baileys eka chunk by chunk encrypt karala disk (tmp) ekata liyala upload karanawa,
    // so full movie eka RAM ekata load wenne na.
    source = Readable.fromWeb(res.body);
    await c.sock.sendMessage(
      c.from,
      {
        document: { stream: source },
        mimetype,
        fileName,
        caption: `🎬 ${title}\n📺 ${stream.quality}${size ? `\n📦 ${fmtSize(size)}` : ''}\n\n> ${c.config.footer}`
      },
      { quoted: c.m }
    );
  } catch (e) {
    console.error('LakVision download error:', clean(e.stack || e.message));
    await c.reply(
      `❌ ${c.font('download failed')}\n${clean(e.message).slice(0, 300)}\n\n` +
      `${c.font('try a lower quality')} (720p / 480p)`
    );
  } finally {
    try { source?.destroy(); } catch {}
    try { opened?.ac.abort(); } catch {}
    busy.delete(c.number);
  }
}

module.exports = {
  name: 'lakvision',
  aliases: ['lv', 'lakvisiontv'],
  category: 'download',
  desc: 'search and download lakvision movies',
  async run(c) {
    if (!c.text) {
      return c.reply(`📌 ${c.font('usage')} : ${c.prefix}lakvision deweni`);
    }
    // The upstream search can take time. Reply before waiting on the API so
    // the user knows the bot received the command.
    await c.reply(`⏳ ${c.font('searching lakvision, please wait...')}`);
    try {
      await showSearch(c, c.text, 1);
    } catch (e) {
      console.error('LakVision search error:', clean(e.message));
      await c.reply(`❌ ${clean(e.message)}`);
    }
  }
};
