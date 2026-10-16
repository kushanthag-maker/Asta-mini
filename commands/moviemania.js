const { Readable, Transform } = require('stream');
const { spawn } = require('child_process');

// MovieMania API (private) - key eka methanama
const BASE = 'https://tobi-apisiii-production.up.railway.app/api/moviemania';
const KEY = process.env.MOVIEMANIA_API_KEY;

const LIMIT = 10;
const MAX_BYTES = 1.9 * 1024 ** 3; // WhatsApp document limit ~2GB
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
  if (!KEY) throw new Error('MOVIEMANIA_API_KEY is not configured');
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

// ---------- 3) DOWNLOAD (stream -> WhatsApp mp4 document) ----------
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
      const isFile = res.ok && res.body && !type.includes('json') && !type.includes('html') && !type.startsWith('text/');
      log(`open ${clean(u).slice(0, 80)} -> ${res.status} ${type} ${res.headers.get('content-length') || '?'} bytes`);
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

class ByteLimit extends Transform {
  constructor(limit) {
    super();
    this.limit = limit;
    this.total = 0;
  }

  _transform(chunk, encoding, callback) {
    this.total += chunk.length;
    if (this.total > this.limit) {
      callback(new Error(`Converted MP4 exceeds ${fmtSize(this.limit)}`));
      return;
    }
    callback(null, chunk);
  }
}

// The provider returns Matroska in practice. Remux it to a fragmented MP4
// over pipes so Baileys receives a real MP4 document without buffering the
// complete movie in RAM or writing a temporary movie file to disk.
function createMp4Stream(res) {
  if (!res.body) throw new Error('Movie response has no body');

  const input = Readable.fromWeb(res.body);
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ffmpegError = '';
  ffmpeg.stderr.on('data', chunk => {
    ffmpegError = `${ffmpegError}${chunk}`.slice(-1000);
  });

  const output = ffmpeg.stdout.pipe(new ByteLimit(MAX_BYTES));
  const cleanup = () => {
    try { input.destroy(); } catch {}
    try { ffmpeg.stdin.destroy(); } catch {}
    try { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); } catch {}
  };

  input.on('error', error => output.destroy(error));
  ffmpeg.on('error', error => output.destroy(error));
  ffmpeg.on('close', code => {
    if (code !== 0 && !output.destroyed) {
      output.destroy(new Error(`ffmpeg failed (${code}): ${ffmpegError.trim() || 'unknown error'}`));
    }
  });
  output.on('error', cleanup);
  input.pipe(ffmpeg.stdin);
  return { stream: output, cleanup };
}

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
  let opened;
  let source;
  let streamCleanup;
  try {
    await c.reply(
      `⬇️ ${c.font('downloading')} *${slot.res}* ...\n` +
      `${c.font('converting to mp4 and sending as a document, please wait')}`
    );

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

    const fileName = `${fileSafe(title)}${m.year ? ` (${m.year})` : ''} [${slot.res}].mp4`;

    const converted = createMp4Stream(res);
    source = converted.stream;
    streamCleanup = converted.cleanup;
    log(`sending ${fileName} (${size ? fmtSize(size) : 'unknown size'})`);
    await c.sock.sendMessage(
      c.from,
      {
        document: { stream: source },
        mimetype: 'video/mp4',
        fileName,
        caption: `🎬 ${title}${m.year ? ` (${m.year})` : ''}\n📺 ${slot.res}${size ? ` • ${fmtSize(size)}` : ''}\n\n> ${c.config.footer}`
      },
      { quoted: c.m }
    );
    log('sent OK');
  } catch (e) {
    console.error('[mm] download error:', clean(e.stack || e.message));
    await c.reply(
      `❌ ${c.font('download failed')}\n${clean(e.message).slice(0, 300)}\n\n` +
      `${c.font('try a lower quality')}`
    );
  } finally {
    try { source?.destroy(); } catch {}
    try { streamCleanup?.(); } catch {}
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
    // Do not leave the chat silent while the external search API responds.
    await c.reply(`⏳ ${c.font('searching moviemania, please wait...')}`);
    try {
      await showSearch(c, c.text, 1);
    } catch (e) {
      console.error('[mm] search error:', clean(e.message));
      await c.reply(`❌ ${clean(e.message)}`);
    }
  }
};
