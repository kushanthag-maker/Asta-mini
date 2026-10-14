// Baileys 7.x ESM package ekak, so dynamic import() use karanawa.
// (project eka CommonJS widiyatama thiyaganna puluwan)
let cached;

async function loadBaileys() {
  if (cached) return cached;
  const mod = await import('@whiskeysockets/baileys');
  const def = mod.default;
  const makeWASocket =
    typeof def === 'function' ? def : (def && def.default) || mod.makeWASocket;
  const ns = def && typeof def === 'object' ? { ...def, ...mod } : { ...mod };
  cached = { ...ns, makeWASocket };
  return cached;
}

module.exports = { loadBaileys };
