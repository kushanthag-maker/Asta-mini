require('dotenv').config();
const express = require('express');
const path = require('path');
const config = require('./config');
const { connectDB } = require('./lib/db');
const { loadCommands } = require('./lib/handler');
const manager = require('./lib/manager');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/info', (req, res) =>
  res.json({ ok: true, name: config.botName, online: manager.count(), uptime: Math.floor(process.uptime()) })
);

app.get('/api/status/:number', (req, res) =>
  res.json({ ok: true, status: manager.getStatus(String(req.params.number).replace(/\D/g, '')) })
);

app.post('/api/pair', async (req, res) => {
  try {
    const number = String(req.body.number || '').replace(/\D/g, '');
    if (number.length < 8 || number.length > 15) {
      return res.status(400).json({ ok: false, error: 'Country code ekka number eka hariyata danna (e.g. 94771234567)' });
    }
    const code = await manager.pair(number);
    res.json({ ok: true, code, number });
  } catch (e) {
    console.error('Pair error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(config.port, async () => {
  console.log(`🌐 Web running on port ${config.port}`);
  try {
    loadCommands();
    await connectDB();
    await manager.restoreAll();
  } catch (e) {
    console.error('Startup error:', e.message);
  }
});
