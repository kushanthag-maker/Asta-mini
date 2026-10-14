// "Number reply" system: bot eka yawapu message ekakata reply karala number ekak dammama
// eka handle karanna. key = `${number}:${messageId}`
const pending = new Map();
const TTL = 10 * 60 * 1000; // minutes 10

function register(key, data) {
  pending.set(key, { ...data, expires: Date.now() + TTL });
  const t = setTimeout(() => pending.delete(key), TTL);
  t.unref?.();
}

function get(key) {
  const p = pending.get(key);
  if (!p) return null;
  if (p.expires < Date.now()) {
    pending.delete(key);
    return null;
  }
  return p;
}

module.exports = { register, get };
