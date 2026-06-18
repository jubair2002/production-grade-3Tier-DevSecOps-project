require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

function requiredEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required. Set it in Frontend/.env locally or in the Kubernetes manifest (env / secret).`);
  }
  return process.env[name];
}

const BACKEND_URL = requiredEnv('BACKEND_URL');
console.log('BACKEND_URL is:', BACKEND_URL);

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'frontend' });
});

// Proxy all /api/* calls to the backend
// Browser calls /api/products → frontend server → backend ALB → backend container
app.use('/api', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const url = `${BACKEND_URL}${req.originalUrl}`;
    console.log('Proxying request to:', url);

    const response = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Backend unreachable', detail: err.message });
  }
});

// Serve index.html — set BACKEND to empty so browser calls /api/* on same host
app.get('/{*path}', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  // Browser calls /api/products which hits THIS express server, which proxies to backend
  html = html.replace('__BACKEND_URL__', '');
  res.send(html);
});

app.listen(PORT, () => {
  console.log('Frontend running on http://localhost:' + PORT);
});
