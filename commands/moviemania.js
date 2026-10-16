const { Readable } = require('stream');

// MovieMania API ( tho ponna kariya meka gnna epa harida tho)
const BASE = 'https://tobi-apisiii-production.up.railway.app/api/moviemania';
const KEY = process.env.MOVIEMANIA_API_KEY || '';

const LIMIT = 10;
const MAX_BYTES = 1.9 * 1024 ** 3; // WhatsApp document limit ~2GB (meke 2gb limite ekk dala tiynne)
const busy = new Set(); // number -> eka welawata download ekak ( oken wennw number rwply seen eka)

const https = u => (u || '').replace(/^http:\/\//i, 'https://');
const clean = s => String(s || '').replace(/apikey=[^&\s]+/gi, 'apikey=***'); // key leak wenna epa
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const fileSafe = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
const fmtSize = b => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB');

// "858MB" / "1.58GB" -> bytes
function sizeToBytes(s) {
  const m = String(s || '').match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!m) return 0;
  const u = m[2].toUpperCase();
  return parseFloat(m[1]) * (u === 'GB' ? 1024 ** 3 : u === 'MB' ? 1024 ** 2 : 1024);
}

async function api(endpoint, params = {}) {
  if (!KEY) throw new Error('API key missing: set the required API key in environment variables');
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
  const data = await api('search', { q: query, limit: LIMIT, page });
  const results = data.results || [];
  if (!results.length) return c.reply(`❌ ${c.font('no results for')} "${query}"`);

  const hasNext = (data.total || 0) > page * LIMIT;

  let text =
`╭━━〔 ${c.font('moviemania search')} 〕━━⬣
┃ 🔎 ${c.font('query')} : ${query}
┃ 📄 ${c.font('page')} : ${page} • ${c.font('total')} : ${data.total ?? results.length}
╰━━━━━━━━━━━━━━⬣\n\n`;

  results.forEach((r, i) => {
    const meta = [r.year, r.rating ? `⭐${r.rating}` : '', r.quality].filter(Boolean).join(' • ');
    text += `*${i + 1}* ➤ ${cut(r.title || 'Untitled', 60)}${meta ? `\n      _${meta}_` : ''}\n`;
  });
  text += `\n↩️ ${c.font('reply with a number to get info')}`;
  if (hasNext) text += `\n➡️ ${c.font('reply')} *next* ${c.font('for next page')}`;
  text += `\n\n> ${c.config.footer}`;

  const sent = await c.reply(text);

  c.waitReply(sent, async (c2, input) => {
    const t = input.trim().toLowerCase();

    if ((t === 'next' || t === 'n') && hasNext) {
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
  const { movie } = await api('info', { id: item.id });
  const m = movie || {};

  // 480p / 720p / 1080p - podi ewa issellama
  const downloads = (m.downloads || [])
    .filter(d => d.directDownloadUrl || d.url)
    .sort((a, b) => parseInt(a.resolution, 10) - parseInt(b.resolution, 10));

  const title = m.title || item.title || 'Unknown';
  const poster = m.poster || item.poster || m.backdrop || '';

  let caption =
`╭━━〔 ${c.font('movie info')} 〕━━⬣
┃ 🎬 ${title}${m.year ? ` (${m.year})` : ''}
┃ ⭐ ${m.rating || '-'}   ⏱️ ${m.runtime || '-'}
┃ 🎭 ${cut(m.genre || '-', 40)}
┃ 🎥 ${cut(m.director || '-', 40)}
┃ 🌍 ${cut(m.country || '-', 30)}
┃ 💿 ${m.quality || '-'}
╰━━━━━━━━━━━━━━⬣\n`;
  if (m.description) caption += `\n📝 ${cut(m.description, 260)}\n`;

  if (!downloads.length) {
    caption += `\n❌ ${c.font('no download links for this one')}`;
  } else {
    caption += `\n`;
    downloads.forEach((d, i) => {
      caption += `*${i + 1}* ➤ ${d.resolution || d.quality}${d.size ? ` • ${d.size}` : ''}\n`;
    });
    caption += `\n↩️ ${c.font('reply with a number to download')}`;
  }
  caption += `\n\n> ${c.config.footer}`;

  let sent;
  try {
    if (!poster) throw new Error('no poster');
    sent = await c.sock.sendMessage(c.from, { image: { url: https(poster) }, caption }, { quoted: c.m });
  } catch {
    sent = await c.reply(caption); // poster nathnam / fail unoth text witharak
  }
  if (!downloads.length) return;

  c.waitReply(sent, async (c2, input) => {
    const t = input.trim();
    if (!/^\d+$/.test(t)) return false;

    const n = parseInt(t, 10);
    if (n < 1 || n > downloads.length) {
      await c2.reply(`❌ 1 - ${downloads.length} athara number ekak danna`);
      return true;
    }
    await download(c2, m, title, downloads[n - 1]);
    return true;
  });
}

// ---------- 3) DOWNLOAD (stream -> WhatsApp mp4 document) ----------
// URLs list eken mulinma wada karana eka open karanawa
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

async function download(c, m, title, d) {
  if (busy.has(c.number)) {
    return c.reply(`⏳ ${c.font('another download is running, please wait')}`);
  }

  const declared = sizeToBytes(d.size);
  if (declared > MAX_BYTES) {
    return c.reply(
      `❌ ${c.font('file is too big for whatsapp')} (${d.size})\n` +
      `${c.font('choose a lower quality')}`
    );
  }

  busy.add(c.number);
  let opened;
  let source;
  try {
    const urls = [https(d.directDownloadUrl), d.url].filter((u, i, a) => u && a.indexOf(u) === i);
    opened = await openFirst(urls);
    const { res } = opened;

    const size = Number(res.headers.get('content-length') || 0) || declared;
    if (size > MAX_BYTES) {
      return c.reply(
        `❌ ${c.font('file is too big for whatsapp')} (${fmtSize(size)})\n` +
        `${c.font('choose a lower quality')}`
      );
    }

    const res_ = d.resolution || d.quality || '';
    const fileName = `${fileSafe(title)}${m.year ? ` (${m.year})` : ''} [${res_}].mp4`;

    await c.reply(
      `⬇️ ${c.font('downloading')} *${res_}*${size ? ` (${fmtSize(size)})` : ''} ...\n` +
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
        mimetype: 'video/mp4',
        fileName,
        caption: `🎬 ${title}${m.year ? ` (${m.year})` : ''}\n📺 ${res_}${size ? ` • ${fmtSize(size)}` : ''}\n\n> ${c.config.footer}`
      },
      { quoted: c.m }
    );
  } catch (e) {
    console.error('MovieMania download error:', clean(e.stack || e.message));
    await c.reply(
      `❌ ${c.font('download failed')}\n${clean(e.message).slice(0, 300)}\n\n` +
      `${c.font('try a lower quality')}`
    );
  } finally {
    try { source?.destroy(); } catch {}
    try { opened?.ac.abort(); } catch {}
    busy.delete(c.number);
  }
}

module.exports = {
  name: 'moviemania',
  aliases: ['mm', 'mmania'],
  category: 'download',
  desc: 'search and download movies (moviemania)',
  async run(c) {
    if (!c.text) {
      return c.reply(`📌 ${c.font('usage')} : ${c.prefix}moviemania fast`);
    }
    try {
      await showSearch(c, c.text, 1);
    } catch (e) {
      console.error('MovieMania search error:', clean(e.message));
      await c.reply(`❌ ${clean(e.message)}`);
    }
  }
};
