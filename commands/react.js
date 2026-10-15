// WhatsApp Channel React API (private) - key eka methanama
const BASE = 'https://tobi-apisiii-production.up.railway.app/api/wpreact/react';
const KEY = 'tobi_live_e7cd4575c745f543638747ed';

const OWNER_ONLY = true;     // true = bot link karapu account eken (fromMe) witharai wada karanne
const COOLDOWN_MS = 15000;   // eka user ekata react 2k athara wela
const DEFAULT_COUNT = 100;
const MAX_COUNT = 1000;      // wedi karanna ona nam me eka wenas karanna
const MAX_EMOJIS = 10;
const DEFAULT_EMOJIS = ['❤️', '🔥'];

const URL_RE = /https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[\w-]+\/\d+[^\s]*/i;
const clean = s => String(s || '').replace(/apikey=[^&\s]+/gi, 'apikey=***'); // key leak wenna epa
const last = new Map(); // sender -> last used time

// link eka message eke ho reply karapu message eke hoyagannawa
function findUrl(c) {
  const direct = (c.text || '').match(URL_RE);
  if (direct) return direct[0];
  const msg = c.m.message || {};
  const inner = msg.ephemeralMessage?.message || msg;
  const q = inner.extendedTextMessage?.contextInfo?.quotedMessage;
  const qt = q?.conversation || q?.extendedTextMessage?.text || '';
  return (qt.match(URL_RE) || [])[0] || null;
}

// ".react <link> <count> <emojis>" - order eka wenas unath ok
function parse(c) {
  const link = findUrl(c);
  let rest = c.text || '';
  if (link) rest = rest.replace(link, ' ');

  let count;
  const emojis = [];
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  for (const tok of rest.split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+$/.test(tok) && count === undefined) { count = parseInt(tok, 10); continue; }
    for (const { segment } of seg.segment(tok)) {
      if (/\p{Extended_Pictographic}/u.test(segment) && !emojis.includes(segment)) emojis.push(segment);
    }
  }
  return { link, count: count ?? DEFAULT_COUNT, emojis: emojis.length ? emojis : DEFAULT_EMOJIS };
}

module.exports = {
  name: 'react',
  aliases: ['chreact', 'creact'],
  category: 'tools',
  desc: 'send reactions to a channel post',
  async run(c) {
    if (OWNER_ONLY && !c.m.key.fromMe) {
      return c.reply(`🔒 ${c.font('this command is owner only')}`);
    }

    const { link, count, emojis } = parse(c);
    if (!link) {
      return c.reply(
        `📌 ${c.font('usage')} :\n` +
        `${c.prefix}react <channel post link> <count> <emojis>\n\n` +
        `${c.font('example')} :\n` +
        `${c.prefix}react https://whatsapp.com/channel/0029Vaxxxx/123 350 🔥,❤️`
      );
    }
    if (count < 1 || count > MAX_COUNT) {
      return c.reply(`❌ ${c.font('count must be between')} 1 - ${MAX_COUNT}`);
    }
    if (emojis.length > MAX_EMOJIS) {
      return c.reply(`❌ ${c.font('max emojis')} : ${MAX_EMOJIS}`);
    }

    const wait = COOLDOWN_MS - (Date.now() - (last.get(c.sender) || 0));
    if (wait > 0) return c.reply(`⏳ ${c.font('please wait')} ${Math.ceil(wait / 1000)}s`);
    last.set(c.sender, Date.now());

    try {
      const url = new URL(BASE);
      url.searchParams.set('url', link);
      url.searchParams.set('count', String(count));
      url.searchParams.set('emojis', emojis.join(','));
      url.searchParams.set('apikey', KEY);

      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.success === false) {
        throw new Error(json?.error || json?.message || `API error (${res.status})`);
      }

      const d = json.details || {};
      const secs = json.durationMs ? (json.durationMs / 1000).toFixed(1) + 's' : '-';
      const left = json._quota?.requestsRemaining;

      const text =
`╭━━〔 ${c.font('channel react')} 〕━━⬣
┃ ✅ ${c.font(json.message || 'request submitted')}
┃ 📢 ${c.font('channel')} : ${d.channelId || '-'}
┃ 🧾 ${c.font('post')} : ${d.postId || '-'}
┃ 🔢 ${c.font('count')} : ${d.count ?? count}
┃ 😀 ${c.font('emojis')} : ${(d.emojis || emojis).join(' ')}
┃ ⏱️ ${c.font('time')} : ${secs}${left !== undefined ? `\n┃ 📊 ${c.font('api calls left')} : ${left}` : ''}
╰━━━━━━━━━━━━━━⬣

> ${c.config.footer}`;

      await c.reply(text);
    } catch (e) {
      last.delete(c.sender); // fail unoth cooldown eka ain karanawa
      console.error('React error:', clean(e.message));
      await c.reply(`❌ ${c.font('react failed')}\n${clean(e.message).slice(0, 300)}`);
    }
  }
};
