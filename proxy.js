import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.use('/api', async (req, res) => {
  const start = Date.now();
  const targetUrl = `https://api.nrfcloud.com/v1${req.url}`;

  const headers = {
    'Authorization': req.headers.authorization,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (req.headers['x-team-id']) headers['X-Team-Id'] = req.headers['x-team-id'];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type');
    const data = contentType?.includes('application/json')
      ? await response.json()
      : await response.text();

    res.set('X-Proxy-Latency', `${Date.now() - start}ms`);
    res.status(response.status);
    if (contentType?.includes('application/json')) {
      res.json(data);
    } else {
      res.send(data);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gateway timeout' });
    }
    console.error('[Proxy]', err.message);
    res.status(502).json({ error: 'Bad gateway', detail: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`🚀 Proxy nRF Cloud rodando em http://localhost:${PORT}`);
  console.log(`   Endpoint: http://localhost:${PORT}/api`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
});