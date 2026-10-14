// LakVision API (private) - key eka methanama
const BASE = 'https://tobi-apisiii-production-f83b.up.railway.app/api/lakvision';
const KEY = 'tobi_live_e53384555640af9573048f47';

const busy = new Set(); // number -> eka welawata download ekak witharai

const https = u => (u || '').replace(/^http:\/\//i, 'https://');
const clean = s => String(s || '').replace(/apikey=[^&\s]+/gi, 'apikey=***'); // key leak wenna epa
const trim = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fileSafe = s => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

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
async function download(c, data, title, stream) {
  if (busy.has(c.number)) {
    return c.reply(`⏳ ${c.font('another download is running, please wait')}`);
  }
  busy.add(c.number);

  try {
    const url =
      https(stream.directDownloadUrl) ||
      `${BASE}/download?id=${data.id}&quality=${parseInt(stream.quality, 10)}&direct=true&apikey=${KEY}`;

    const fmt = String(stream.format || 'mp4').toLowerCase();
    const ext = fmt === 'mkv' ? 'mkv' : 'mp4';
    const mimetype = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    const fileName = `${fileSafe(title)} [${stream.quality}].${ext}`;

    await c.reply(
      `⬇️ ${c.font('downloading')} *${stream.quality}* ...\n` +
      `${c.font('big files take a few minutes, please wait')}`
    );

    // { url } dunnama Baileys eka ama file eka STREAM karala upload karanawa
    // (RAM ekata full movie eka load wenne na)
    await c.sock.sendMessage(
      c.from,
      {
        document: { url },
        mimetype,
        fileName,
        caption: `🎬 ${title}\n📺 ${stream.quality}\n\n> ${c.config.footer}`
      },
      { quoted: c.m }
    );
  } catch (e) {
    console.error('LakVision download error:', clean(e.stack || e.message));
    await c.reply(
      `❌ ${c.font('download failed')}\n${clean(e.message)}\n\n` +
      `${c.font('try a lower quality')} (720p / 480p)`
    );
  } finally {
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
    try {
      await showSearch(c, c.text, 1);
    } catch (e) {
      console.error('LakVision search error:', clean(e.message));
      await c.reply(`❌ ${clean(e.message)}`);
    }
  }
};
