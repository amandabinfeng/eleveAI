# Élevé AI — Ballet Performance Coach

AI-powered ballet technique analysis. Upload a real video, AI Vision analyzes your actual frames.

## Run in GitHub Codespaces (recommended)

### 1. Add your API key as a secret
- GitHub → Settings → Codespaces → Secrets → New secret
- Name: `OPENAI_API_KEY`, value: your key from (https://platform.openai.com/api-keys)
- Grant access to this repository

### 2. Open in Codespaces
Click **Code** → **Codespaces** → **Create codespace on main**
RUN:
npm install
node server.js

Codespaces auto-runs `npm install` and `npm start`, then pops up:
> "Your app on port 3001 is available" → **Open in Browser**

### 3. Use the app
Your URL looks like: `https://YOUR-CODESPACE-3001.app.github.dev`

The sidebar shows **● Codespaces** when connected.

---

## Run locally
```bash
git clone https://github.com/YOUR_USERNAME/eleve-ai
cd eleve-ai
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# Open: http://localhost:3001
```

---

## Features
- **Solo Analysis** — Upload one video, get technique scores + coaching feedback from AI Vision
- **Benchmark Comparison** — Compare your video against a professional reference
- **Progress Tracking** — Compare two of your own videos to see what's improved

## How it works
1. Browser extracts 10 frames evenly from your video (Canvas API)
2. 5 frames sent as images to AI Vision via the proxy server
3. Claude analyzes actual body position in each frame
4. Scores + specific coaching feedback returned

~$0.02–0.05 per analysis. No video is stored.
