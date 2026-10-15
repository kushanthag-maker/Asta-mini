require('dotenv').config();
require('./lib/quietLogs');

const express = require('express');
const path = require('path');
const config = require('./config');
const { connectDB, closeDB } = require('./lib/db');
const { loadCommands } = require('./lib/handler');
const manager = require('./lib/manager');

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port (1-65535)');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Small in-memory limiter for pairing endpoint. Use a proxy-aware limiter at scale.
const pairAttempts = new Map();
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX = 5;
function pairRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const old = pairAttempts.get(ip);
  if (!old || now - old.start >= PAIR_WINDOW_MS) {
    pairAttempts.set(ip, { start: now, count: 1 });
    return next();
  }
  if (old.count >= PAIR_MAX) {
    res.set('Retry-After', String(Math.ceil((PAIR_WINDOW_MS - (now - old.start)) / 1000)));
    return res.status(429).json({ ok: false, error: 'Too many pairing requests. Please wait a minute.' });
  }
  old.count += 1;
  return next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, value] of pairAttempts) {
    if (now - value.start >= PAIR_WINDOW_MS) pairAttempts.delete(ip);
  }
}, PAIR_WINDOW_MS).unref();

app.get('/api/info', (_req, res) => res.json({
  ok: true,
  name: config.botName,
  online: manager.count(),
  uptime: Math.floor(process.uptime())
}));

app.get('/api/status/:number', (req, res) => {
  const number = String(req.params.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ ok: false, error: 'Invalid phone number' });
  }
  return res.json({ ok: true, status: manager.getStatus(number) });
});

app.get('/ping', (_req, res) => res.json({
  ok: true,
  time: Date.now(),
  uptime: Math.floor(process.uptime())
}));

app.post('/api/pair', pairRateLimit, async (req, res) => {
  const number = String(req.body?.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a valid phone number with country code (example: 94771234567)'
    });
  }

  try {
    const code = await manager.pair(number);
    return res.json({ ok: true, code, number });
  } catch (error) {
    console.error('Pair error:', error.message);
    const status = /already connected|already starting|in progress/i.test(error.message) ? 409 : 400;
    return res.status(status).json({ ok: false, error: error.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error('HTTP error:', err.message);
  if (res.headersSent) return;
  return res.status(err.status || 500).json({ ok: false, error: 'Request could not be processed' });
});

let server;
let stopping = false;
async function start() {
  // Connect DB before exposing pairing routes, avoiding half-started app state.
  await connectDB();
  loadCommands();
  await manager.restoreAll();
  server = app.listen(config.port, () => console.log(`🌐 Web running on port ${config.port}`));
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`🛑 ${signal}: shutting down...`);
  try {
    await manager.shutdown();
    if (server) await new Promise(resolve => server.close(resolve));
    await closeDB();
  } catch (error) {
    console.error('Shutdown error:', error.message);
  } finally {
    process.exit(0);
  }
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error?.message || error));
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error?.stack || error);
  // An uncaught exception may leave the process in an unsafe state.
  shutdown('uncaughtException');
});

start().catch(error => {
  console.error('Startup failed:', error.message);
  process.exitCode = 1;
  closeDB().catch(() => {});
});
