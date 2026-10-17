const { Readable } = require('stream');

// MovieMania API (private) - key eka methanama
const BASE = 'https://tobi-apisiii-production.up.railway.app/api/moviemania';
const KEY = 'tobi_live_e7cd4575c745f543638747ed';

const LIMIT = 10;
const MAX_BYTES = 1.9 * 1024 ** 3; // WhatsApp document limit ~2GB
const MAX_BUFFER_BYTES = 64 * 1024 ** 2; // buffer fallback eka podi files walata witharai (dyno RAM 512MB)
const PROBE_TIMEOUT_MS = Number(process.env.MM_PROBE_TIMEOUT_MS) || 30000;
const SEND_TIMEOUT_MS = 45 * 60 * 1000; // eka movie ekak yawanna adhika wasayen minutes 45
const RESOLUTIONS = [480, 720, 1080]; // hama movie ekatama me 3 slots penawanawa
const busy = new Set(); // number -> eka welawata download ekak witharai

const https = u => (u || '').replace(/^http:\/\//i, 'https://');
const clean = s => String(s || '').replace(/apikey=[^&\s]+/gi, 'apikey=***'); // key leak wenna epa
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const fileSafe = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
const fmtSize = b => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB');
const log = (...a) => console.log('[mm]', ...a);

// "858MB" / "1.58GB" -> bytes
function sizeToBytes(s) {
  const m = String(s || '').match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!m) return 0;
  const u = m[2].toUpperCase();
  return parseFloat(m[1]) * (u === 'GB' ? 1024 ** 3 : u === 'MB' ? 1024 ** 2 : 1024);
}

// "720p" / "HD 720p" -> 720
const resOf = d => {
  const m = String(d.resolution || '').match(/\d{3,4}/) || String(d.quality || '').match(/\d{3,4}/);
  return m ? parseInt(m[0], 10) : 0;
};

async function api(endpoint, params = {}) {
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
  const params = { q: query, limit: LIMIT };
  if (page > 1) params.page = page;

  const data = await api('search', params);
  const results = data.results || data.data || [];
  log(`search "${query}" page=${page} -> ${results.length} results`);
  if (!results.length) return c.reply(`❌ ${c.font('no results for')} "${query}"`);

  const hasNext = data.total ? data.total > page * LIMIT : results.length >= LIMIT;

  let text =
`╭━━〔 ${c.font('moviemania search')} 〕━━⬣
┃ 🔎 ${c.font('query')} : ${query}
┃ 📄 ${c.font('page')} : ${page}${data.total ? ` • ${c.font('total')} : ${data.total}` : ''}
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
    await showInfo(c2, results[n - 1]).catch(e => {
      console.error('[mm] info error:', clean(e.message));
      return c2.reply(`❌ ${clean(e.message)}`);
    });
    return true;
  });
}

// ---------- 2) INFO + QUALITY (480p / 720p / 1080p) ----------
async function showInfo(c, item) {
  const j = await api('info', { id: item.id });
  const m = j.movie || j.data || j;

  const downloads = (m.downloads || []).filter(d => d.directDownloadUrl || d.url);
  log(`info ${item.id} -> downloads: ${downloads.map(d => `${resOf(d) || d.quality}(${d.size || '?'})`).join(', ') || 'none'}`);

  // slot 1 = 480p, slot 2 = 720p, slot 3 = 1080p (nathi ewa "not available" kiyala pennanawa)
  let slots = RESOLUTIONS.map(r => ({ res: `${r}p`, d: downloads.find(d => resOf(d) === r) || null }));
  if (!slots.some(s => s.d)) {
    // me 3 ma nathnam thiyena ewa penawanawa
    slots = downloads.map(d => ({ res: d.resolution || d.quality || '?', d }));
  }

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
  if (m.description) caption += `\n📝 ${cut(m.description, 240)}\n`;

  if (!slots.length) {
    caption += `\n❌ ${c.font('no download links for this one')}`;
  } else {
    caption += `\n`;
    slots.forEach((s, i) => {
      caption += s.d
        ? `*${i + 1}* ➤ ${s.res}${s.d.size ? ` • ${s.d.size}` : ''}\n`
        : `*${i + 1}* ➤ ${s.res} • ❌ ${c.font('not available')}\n`;
    });
    caption += `\n↩️ ${c.font('reply with a number to download')}`;
  }
  caption += `\n\n> ${c.config.footer}`;

  let sent;
  try {
    if (!poster) throw new Error('no poster');
    sent = await c.sock.sendMessage(c.from, { image: { url: https(poster) }, caption }, { quoted: c.m });
  } catch (e) {
    log('poster send failed, sending text only:', e.message);
    sent = await c.reply(caption); // poster nathnam / fail unoth text witharak
  }
  if (!slots.length) return;

  c.waitReply(sent, async (c2, input) => {
    const t = input.trim().toLowerCase().replace(/p$/, '');
    if (!/^\d+$/.test(t)) return false;

    const n = parseInt(t, 10);
    // "1/2/3" ho "480/720/1080" dekama wada
    const slot = n >= 1 && n <= slots.length ? slots[n - 1] : slots.find(s => parseInt(s.res, 10) === n);
    if (!slot) {
      await c2.reply(`❌ 1 - ${slots.length} athara number ekak danna`);
      return true;
    }
    if (!slot.d) {
      await c2.reply(`❌ ${slot.res} ${c2.font('is not available for this movie')}`);
      return true;
    }
    await download(c2, m, title, slot);
    return true;
  });
}

// ---------- 3) DOWNLOAD (Baileys url-stream -> stream -> small buffer) ----------
// URL eka wada karanawada kiyala headers witharak balanawa (Range: bytes=0-0, body eka read karanne na).
// Timeout ekak thiyenawa, so hang wela busy lock eka stuck wenne na.
async function probe(u) {
  const attempt = async withRange => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(u, { headers: withRange ? { Range: 'bytes=0-0' } : {}, signal: ac.signal, redirect: 'follow' });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const range = res.headers.get('content-range'); // "bytes 0-0/858000000"
      const size = range ? Number(range.split('/')[1]) || 0 : (res.status === 206 ? 0 : Number(res.headers.get('content-length') || 0));
      try { await res.body?.cancel(); } catch {}
      return { status: res.status, ok: res.ok, type, size };
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  };

  let r = await attempt(true);
  if (!r.ok && [400, 403, 405, 416, 501].includes(r.status)) r = await attempt(false); // Range support nathi server walata
  log(`probe ${clean(u).slice(0, 90)} -> ${r.status} ${r.type} ${r.size || '?'} bytes`);

  const notMedia = r.type.includes('json') || r.type.includes('html') || r.type.startsWith('text/');
  const tooSmall = r.size > 0 && r.size < 1024 * 1024; // 1MB walata adu = movie ekak nemei (wrapper page ekak)
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (notMedia) throw new Error(`not a video (${r.type || 'unknown type'})`);
  if (tooSmall) throw new Error(`too small to be a movie (${r.size} bytes)`);
  return { url: u, size: r.size, type: r.type };
}

// real file URL eka (quota use wenne na) mulin, API URL eka passe
async function pickSource(urls) {
  const errors = [];
  for (const u of urls) {
    try {
      return await probe(u);
    } catch (e) {
      errors.push(`${clean(u).slice(0, 60)} -> ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

// RAM ekata ganna puluwan podi files walata witharai (limit eka watunama nawaththanawa)
async function readLimitedBuffer(url, limit) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`buffer HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') || 0) > limit) throw new Error(`too big for buffer (${fmtSize(limit)} limit)`);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`too big for buffer (${fmtSize(limit)} limit)`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('send timed out'), { sendTimeout: true })), ms).unref?.())]);

async function download(c, m, title, slot) {
  if (busy.has(c.number)) {
    return c.reply(`⏳ ${c.font('another download is running, please wait')}`);
  }

  const d = slot.d;
  const declared = sizeToBytes(d.size);
  if (declared > MAX_BYTES) {
    return c.reply(
      `❌ ${c.font('file is too big for whatsapp')} (${d.size})\n` +
      `${c.font('choose a lower quality')}`
    );
  }

  busy.add(c.number);
  const errors = [];
  let source;
  try {
    await c.reply(
      `⬇️ ${c.font('downloading')} *${slot.res}*${d.size ? ` (${d.size})` : ''} ...\n` +
      `${c.font('sending as a document, big files take a few minutes, please wait')}`
    );

    // 1) URL eka select karanawa. d.url = real file (API quota use wenne na), directDownloadUrl = API (quota 1k yanawa)
    const urls = [https(d.url), https(d.directDownloadUrl)].filter((u, i, a) => u && a.indexOf(u) === i);
    const src = await pickSource(urls);

    const size = src.size || declared;
    if (size > MAX_BYTES) {
      return c.reply(
        `❌ ${c.font('file is too big for whatsapp')} (${fmtSize(size)})\n` +
        `${c.font('choose a lower quality')}`
      );
    }

    const isMkv = src.type.includes('matroska') || /\.mkv(?:\?|$)/i.test(src.url);
    const ext = isMkv ? 'mkv' : 'mp4';
    const mimetype = isMkv ? 'video/x-matroska' : (src.type.startsWith('video/') ? src.type.split(';')[0] : 'video/mp4');
    const fileName = `${fileSafe(title)}${m.year ? ` (${m.year})` : ''} [${slot.res}].${ext}`;
    const caption = `🎬 ${title}${m.year ? ` (${m.year})` : ''}\n📺 ${slot.res}${size ? ` • ${fmtSize(size)}` : ''}\n\n> ${c.config.footer}`;
    const msgOpts = { quoted: c.m };
    log(`sending ${fileName} (${size ? fmtSize(size) : 'unknown size'}) from ${clean(src.url).slice(0, 70)}`);

    // A) Baileys eka URL eken ama STREAM karanawa (Dark Queen widiyata) - RAM use wenne na
    try {
      log('A: baileys url stream');
      await withTimeout(c.sock.sendMessage(c.from, { document: { url: src.url }, mimetype, fileName, caption }, msgOpts), SEND_TIMEOUT_MS);
      log('sent OK (A)');
      return;
    } catch (e) {
      errors.push(`A: ${clean(e.message)}`);
      log('A failed:', clean(e.message));
      if (e.sendTimeout) throw e; // still uploading wenna puluwan - double send karanna epa
    }

    // B) apima fetch karala stream ekak widiyata Baileys ekata denawa
    try {
      log('B: fetch -> stream');
      const ac = new AbortController();
      const res = await fetch(src.url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      source = Readable.fromWeb(res.body);
      await withTimeout(c.sock.sendMessage(c.from, { document: { stream: source }, mimetype, fileName, caption }, msgOpts), SEND_TIMEOUT_MS);
      log('sent OK (B)');
      return;
    } catch (e) {
      errors.push(`B: ${clean(e.message)}`);
      log('B failed:', clean(e.message));
      try { source?.destroy(); } catch {}
      if (e.sendTimeout) throw e;
    }

    // C) buffer - podi files (<= 64MB) witharai. Loku ewa RAM eka naswanawa nisa skip karanawa.
    if (!size || size <= MAX_BUFFER_BYTES) {
      try {
        log('C: buffer fallback');
        const buffer = await readLimitedBuffer(src.url, MAX_BUFFER_BYTES);
        await c.sock.sendMessage(c.from, { document: buffer, mimetype, fileName, caption }, msgOpts);
        log('sent OK (C)');
        return;
      } catch (e) {
        errors.push(`C: ${clean(e.message)}`);
        log('C failed:', clean(e.message));
      }
    } else {
      errors.push(`C: skipped (file ${fmtSize(size)} > buffer limit ${fmtSize(MAX_BUFFER_BYTES)})`);
    }

    throw new Error(errors.join(' | '));
  } catch (e) {
    console.error('[mm] download error:', clean(e.stack || e.message));
    const link = d.url && /^https?:\/\//i.test(d.url) ? `\n\n💡 ${c.font('direct link')} :\n${d.url}` : '';
    await c.reply(
      `❌ ${c.font('download failed')}\n${clean(e.message).slice(0, 400)}\n\n` +
      `${c.font('try a lower quality')}${link}`
    ).catch(() => {});
  } finally {
    try { source?.destroy(); } catch {}
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
      console.error('[mm] search error:', clean(e.message));
      await c.reply(`❌ ${clean(e.message)}`);
    }
  }
};
