// ─── Élevé AI — Proxy Server (works locally AND in GitHub Codespaces) ─────────

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

let fetch;
try {
  fetch = require('node-fetch');
} catch(e) {
  console.error('\n❌  Run:  npm install\n');
  process.exit(1);
}

let multer, GoogleGenerativeAI, GoogleAIFileManager;
try {
  multer = require('multer');
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  ({ GoogleAIFileManager } = require('@google/generative-ai/server'));
} catch(e) {
  console.warn('⚠️  Gemini dependencies not installed — run npm install');
}

const app          = express();
const PORT         = 3001;
const API_KEY      = process.env.OPENAI_API_KEY;
const MODEL        = process.env.OPENAI_MODEL || 'gpt-4o';
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (!API_KEY) {
  console.warn('\n⚠️   OPENAI_API_KEY not set — server will start but analyses will fail.');
  console.warn('    In Codespaces: Settings → Secrets → add OPENAI_API_KEY');
  console.warn('    Locally:       OPENAI_API_KEY=sk-... node server.js\n');
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
    model: MODEL,
    appUrl: `${proto}://${host}/index.html`,
    isCodespaces: !!process.env.CODESPACE_NAME,
  });
});

// OpenAI API proxy
app.post('/api/claude', async (req, res) => {
  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      console.error(`OpenAI API error ${upstream.status}:`, data?.error?.message);
      return res.status(upstream.status).json(data);
    }

    console.log(`✓ Analysis done — tokens: ${data.usage?.total_tokens}`);
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Expose Gemini key to frontend (for direct browser→Gemini upload, bypassing nginx 413 limit)
app.get('/api/gemini-key', (_, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
  res.json({ key: GEMINI_KEY });
});

// Gemini analysis by URI — browser uploads file directly to Gemini, sends us just the URI
if (GoogleGenerativeAI) {
  app.post('/api/gemini-analyze-uri', express.json({ limit: '1mb' }), async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');

    try {
      const { fileUri, mimeType = 'video/mp4', style = 'Classical', desc = '', ageGroup = 'Junior' } = req.body;
      if (!fileUri) throw new Error('No fileUri provided');
      if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');

      send({ status: 'analyzing', message: 'Analysing performance with Gemini…' });

      const ageFocusMap = {
        'Pre-competitive': 'DIVISION: Pre-competitive. COACHING FOCUS: Healthy foundations. Natural posture, relaxed arms, basic turnout, musicality. Be generous — habits are forming.',
        'Junior':          'DIVISION: Junior. COACHING FOCUS: Technical scrutiny. Controlled pirouettes, proper jump prep and landing, safe pointework, emerging épaulement, phrasing awareness.',
        'Senior':          'DIVISION: Senior. COACHING FOCUS: Near-professional standard. High technical floor. Genuine artistic interpretation through the steps, stylistic authenticity.',
      };

      const prompt = `You are a senior ballet adjudicator and coach with 20+ years experience, trained in YAGP evaluation standards.

Watch this full ballet performance video from start to finish. You are seeing continuous movement — assess the complete arc of every jump (including the peak), full rotations of turns, quality of transitions, and dynamic flow across the entire variation.

Ballet style: ${style}.${desc ? ' Dancer context: ' + desc : ''}
${ageFocusMap[ageGroup] || ageFocusMap['Junior']}

Score using the YAGP two-pillar system. Each pillar is 0–100. Overall = average of both.

TECHNIQUE dimensions (each 0–100):
- alignment: Plumb line, neutral pelvis, vertical spine
- turnout: En dehors from the hip (not forced at foot/knee)
- execution: Quality of jumps, turns, extensions, transitions
- pointework: Foot articulation, demi-pointe/pointe safety and control
- musicality: Timing, phrasing, rhythmic accuracy
- control: Strength, stability, balance, clean landings

ARTISTRY dimensions (each 0–100):
- line: Overall body line, length, shape in space
- epaulement: Relationship between arms, head, and torso
- portDeBras: Arm flow and quality through transitions
- style: Fidelity to choreographic style and period conventions
- dynamics: Contrast between fast/slow, light/heavy, tension/release
- presence: Stage projection, professional focus, eye focus
- expression: Authentic emotional connection and commitment to the music

Return ONLY valid JSON (no markdown, no extra text):
{"techniqueScore":<0-100>,"artistryScore":<0-100>,"overallScore":<average rounded>,"technique":{"alignment":<0-100>,"turnout":<0-100>,"execution":<0-100>,"pointework":<0-100>,"musicality":<0-100>,"control":<0-100>},"artistry":{"line":<0-100>,"epaulement":<0-100>,"portDeBras":<0-100>,"style":<0-100>,"dynamics":<0-100>,"presence":<0-100>,"expression":<0-100>},"pose":"<variation name>","positives":[{"text":"<observation>","timeStart":"<e.g. 0:10>","timeEnd":"<e.g. 0:20>"}],"improvements":[{"text":"<actionable correction>","timeStart":"<e.g. 0:15>","timeEnd":"<e.g. 0:25>"}],"coachNote":"<2-3 sentences>"}
2-3 positives, 2-3 improvements.`;

      const genAI  = new GoogleGenerativeAI(GEMINI_KEY);
      const model  = genAI.getGenerativeModel({ model: GEMINI_MODEL, generationConfig: { maxOutputTokens: 4000 } });
      const result = await model.generateContent([{ fileData: { fileUri, mimeType } }, { text: prompt }]);
      const text   = result.response.text();
      console.log('✓ Gemini analysis done');

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Gemini returned no JSON: ' + text.slice(0, 200));

      send({ status: 'done', result: JSON.parse(jsonMatch[0]) });
      res.end();
    } catch (err) {
      console.error('Gemini URI analysis error:', err.message);
      send({ status: 'error', error: err.message });
      res.end();
    }
  });
} else {
  app.get('/api/gemini-key', (_, res) => res.status(503).json({ error: 'Gemini not available' }));
  app.post('/api/gemini-analyze-uri', (_, res) => res.status(503).json({ error: 'Gemini not available — run npm install' }));
}

// Gemini video analysis endpoint (legacy — local use only, nginx blocks large uploads in Codespaces)
if (multer && GoogleGenerativeAI && GoogleAIFileManager) {
  const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

  app.post('/api/gemini-analyze', (req, res) => {
    // Streaming NDJSON — keeps Codespaces proxy alive during long Gemini processing
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');

    let tmpPath = null, uploadedFileName = null;

    const run = async () => {
      // Parse multipart upload
      await new Promise((resolve, reject) => {
        upload.single('video')(req, res, (err) => err ? reject(err) : resolve());
      });

      if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
      if (!req.file)   throw new Error('No video file received');
      tmpPath = req.file.path;

      const { style = 'Classical', desc = '', ageGroup = 'Junior' } = req.body;
      const mimeType = req.file.mimetype || 'video/mp4';

      const fileManager = new GoogleAIFileManager(GEMINI_KEY);
      const genAI       = new GoogleGenerativeAI(GEMINI_KEY);

      send({ status: 'uploading', message: `Uploading ${req.file.originalname} to Gemini…` });
      console.log(`⬆  Uploading ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)} MB) to Gemini…`);
      const uploadResult = await fileManager.uploadFile(tmpPath, { mimeType, displayName: req.file.originalname });
      uploadedFileName = uploadResult.file.name;

      // Poll until ACTIVE — send keepalive every 5 s
      send({ status: 'processing', message: 'Gemini processing video…' });
      let file = await fileManager.getFile(uploadedFileName);
      let attempts = 0;
      while (file.state === 'PROCESSING' && attempts < 36) {
        await new Promise(r => setTimeout(r, 5000));
        send({ status: 'processing', message: `Processing… (${(attempts + 1) * 5}s)` });
        file = await fileManager.getFile(uploadedFileName);
        attempts++;
      }
      if (file.state !== 'ACTIVE') throw new Error(`Gemini file processing failed: ${file.state}`);

      send({ status: 'analyzing', message: 'Analysing performance with Gemini…' });
      console.log('✓ Video ready — starting analysis');

      const ageFocusMap = {
        'Pre-competitive': 'DIVISION: Pre-competitive. COACHING FOCUS: Healthy foundations. Natural posture, relaxed arms, basic turnout, musicality. Be generous — habits are forming.',
        'Junior':          'DIVISION: Junior. COACHING FOCUS: Technical scrutiny. Controlled pirouettes, proper jump prep and landing, safe pointework, emerging épaulement, phrasing awareness.',
        'Senior':          'DIVISION: Senior. COACHING FOCUS: Near-professional standard. High technical floor. Genuine artistic interpretation through the steps, stylistic authenticity.',
      };

      const prompt = `You are a senior ballet adjudicator and coach with 20+ years experience, trained in YAGP evaluation standards.

Watch this full ballet performance video from start to finish. You are seeing continuous movement — assess the complete arc of every jump (including the peak), full rotations of turns, quality of transitions, and dynamic flow across the entire variation.

Ballet style: ${style}.${desc ? ' Dancer context: ' + desc : ''}
${ageFocusMap[ageGroup] || ageFocusMap['Junior']}

Score using the YAGP two-pillar system. Each pillar is 0–100. Overall = average of both.

TECHNIQUE dimensions (each 0–100):
- alignment: Plumb line, neutral pelvis, vertical spine
- turnout: En dehors from the hip (not forced at foot/knee)
- execution: Quality of jumps, turns, extensions, transitions
- pointework: Foot articulation, demi-pointe/pointe safety and control
- musicality: Timing, phrasing, rhythmic accuracy
- control: Strength, stability, balance, clean landings

ARTISTRY dimensions (each 0–100):
- line: Overall body line, length, shape in space
- epaulement: Relationship between arms, head, and torso
- portDeBras: Arm flow and quality through transitions
- style: Fidelity to choreographic style and period conventions
- dynamics: Contrast between fast/slow, light/heavy, tension/release
- presence: Stage projection, professional focus, eye focus
- expression: Authentic emotional connection and commitment to the music

Return ONLY valid JSON (no markdown, no extra text):
{"techniqueScore":<0-100>,"artistryScore":<0-100>,"overallScore":<average rounded>,"technique":{"alignment":<0-100>,"turnout":<0-100>,"execution":<0-100>,"pointework":<0-100>,"musicality":<0-100>,"control":<0-100>},"artistry":{"line":<0-100>,"epaulement":<0-100>,"portDeBras":<0-100>,"style":<0-100>,"dynamics":<0-100>,"presence":<0-100>,"expression":<0-100>},"pose":"<variation name>","positives":[{"text":"<observation>","timeStart":"<e.g. 0:10>","timeEnd":"<e.g. 0:20>"}],"improvements":[{"text":"<actionable correction>","timeStart":"<e.g. 0:15>","timeEnd":"<e.g. 0:25>"}],"coachNote":"<2-3 sentences>"}
2-3 positives, 2-3 improvements.`;

      const model   = genAI.getGenerativeModel({ model: GEMINI_MODEL, generationConfig: { maxOutputTokens: 4000 } });
      const result  = await model.generateContent([{ fileData: { fileUri: file.uri, mimeType } }, { text: prompt }]);
      const text    = result.response.text();
      console.log('✓ Gemini analysis done');

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Gemini returned no JSON: ' + text.slice(0, 200));

      send({ status: 'done', result: JSON.parse(jsonMatch[0]) });
      res.end();
    };

    run().catch((err) => {
      console.error('Gemini error:', err.message);
      send({ status: 'error', error: err.message });
      res.end();
    }).finally(() => {
      if (tmpPath)          try { fs.unlinkSync(tmpPath); } catch(_) {}
      if (uploadedFileName) try { new GoogleAIFileManager(GEMINI_KEY).deleteFile(uploadedFileName); } catch(_) {}
    });
  });
} else {
  app.post('/api/gemini-analyze', (_, res) => res.status(503).json({ error: 'Gemini not available — run npm install' }));
}

app.listen(PORT, '0.0.0.0', () => {
  const isCodespaces = !!process.env.CODESPACE_NAME;
  if (isCodespaces) {
    const fwdUrl = `https://${process.env.CODESPACE_NAME}-${PORT}.app.github.dev`;
    console.log('\n┌─────────────────────────────────────────────────────────────────┐');
    console.log('│              Élevé AI  —  Running in GitHub Codespaces          │');
    console.log('├─────────────────────────────────────────────────────────────────┤');
    console.log(`│  App URL:  ${fwdUrl}/index.html`);
    console.log('│  (Codespaces will also show a popup — click "Open in Browser")  │');
    console.log(`│  OpenAI API key:  ${API_KEY    ? 'loaded ✓' : '⚠️  NOT SET — add in Codespaces Secrets'}`);
    console.log(`│  Gemini API key:  ${GEMINI_KEY ? 'loaded ✓' : '⚠️  NOT SET — Gemini analysis unavailable'}`);
    console.log('└─────────────────────────────────────────────────────────────────┘\n');
  } else {
    console.log('\n┌──────────────────────────────────────────────────────┐');
    console.log('│           Élevé AI  —  Local Proxy Server            │');
    console.log('├──────────────────────────────────────────────────────┤');
    console.log(`│  Open:  http://localhost:${PORT}/index.html  │`);
    console.log(`│  OpenAI API key: ${API_KEY ? 'loaded ✓' : '⚠️  NOT SET'}                    │`);
    console.log('└──────────────────────────────────────────────────────┘\n');
  }
});
