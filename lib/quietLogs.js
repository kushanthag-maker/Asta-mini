// libsignal ekin console.info eken "Closing session: SessionEntry {...}" kiyala loku dump ekak
// hama message ekatama print wenawa (Heroku logs ona nathuwama bara wenawa).
// Ewa filter karala, minute ekakata eka summary line ekak witharak pennanawa.
const NOISY = [
  'Closing session',
  'Opening session',
  'Removing old closed session',
  'Migrating session',
  'Session already closed',
  'Session already open',
  'Closing open session',
  'Closing stale open session',
  'Decrypted message with closed session'
];

let hits = 0;
const originals = {};

for (const m of ['log', 'info', 'warn']) {
  originals[m] = console[m].bind(console);
  console[m] = (...args) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (NOISY.some(p => first.startsWith(p))) {
      hits++;
      return;
    }
    originals[m](...args);
  };
}

setInterval(() => {
  if (hits) {
    originals.log(`[signal] ${hits} session open/close events in the last 60s`);
    hits = 0;
  }
}, 60000).unref();
