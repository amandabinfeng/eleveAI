// ─── Élevé AI — Proxy Server (works locally AND in GitHub Codespaces) ─────────

const express = require('express');
const cors    = require('cors');
const path    = require('path');

let fetch;
try {
  fetch = require('node-fetch');
} catch(e) {
  console.error('\n❌  Run:  npm install\n');
  process.exit(1);
}

const app     = express();
const PORT    = 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('\n❌  ANTHROPIC_API_KEY not set.\n');
  console.error('    In Codespaces: Secrets → add ANTHROPIC_API_KEY');
  console.error('    Locally:       ANTHROPIC_API_KEY=sk-ant-... node server.js\n');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.dirname(__filename)));

// Root redirects to the app
app.get('/', (_, res) => res.redirect('/index.html'));

// Health check — also returns the Codespaces forwarded URL if available
app.get('/health', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  res.json({
    ok: true,
    model: 'claude-sonnet-4-20250514',
    appUrl: `${proto}://${host}/index.html`,
    isCodespaces: !!process.env.CODESPACE_NAME,
  });
});

// Claude API proxy
app.post('/api/claude', async (req, res) => {
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error(`Claude API error ${upstream.status}:`, data?.error?.message);
      return res.status(upstream.status).json(data);
    }

    console.log(`✓ Analysis done — input: ${data.usage?.input_tokens} tokens, output: ${data.usage?.output_tokens} tokens`);
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const isCodespaces = !!process.env.CODESPACE_NAME;
  if (isCodespaces) {
    const fwdUrl = `https://${process.env.CODESPACE_NAME}-${PORT}.app.github.dev`;
    console.log('\n┌─────────────────────────────────────────────────────────────────┐');
    console.log('│              Élevé AI  —  Running in GitHub Codespaces          │');
    console.log('├─────────────────────────────────────────────────────────────────┤');
    console.log(`│  App URL:  ${fwdUrl}/index.html`);
    console.log('│  (Codespaces will also show a popup — click "Open in Browser")  │');
    console.log('│  Claude API key: loaded ✓                                       │');
    console.log('└─────────────────────────────────────────────────────────────────┘\n');
  } else {
    console.log('\n┌──────────────────────────────────────────────────────┐');
    console.log('│           Élevé AI  —  Local Proxy Server            │');
    console.log('├──────────────────────────────────────────────────────┤');
    console.log(`│  Open:  http://localhost:${PORT}/index.html  │`);
    console.log('│  Claude API key: loaded ✓                             │');
    console.log('└──────────────────────────────────────────────────────┘\n');
  }
});
