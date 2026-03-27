# Élevé AI — Ballet Performance Coach

AI-powered ballet technique analysis. Upload a video, Gemini AI watches the full performance and returns scores + specific coaching feedback.

## Run in GitHub Codespaces (recommended)

### 1. Add your Gemini API key as a secret
- GitHub → Settings → Codespaces → Secrets → New secret
- Name: `GEMINI_API_KEY`, value: your key from [Google AI Studio](https://aistudio.google.com/apikey)
- Grant access to this repository

### 2. Open in Codespaces
Click **Code** → **Codespaces** → **Create codespace on main**

Then in the terminal:
```bash
npm install
node server.js
```

When you see the port 3001 popup → **Open in Browser**

### 3. Use the app
Your URL looks like: `https://YOUR-CODESPACE-3001.app.github.dev`

---

## Run locally
```bash
git clone https://github.com/amandabinfeng/eleveAI
cd eleveAI
npm install
GEMINI_API_KEY=your-key-here node server.js
# Open: http://localhost:3001
```

---

## Features
- **Solo Analysis** — Upload one video, get 13-dimension technique + artistry scores and specific coaching feedback with timestamps
- **Progress Tracking** — Compare two of your own videos to track improvement over time

## Model
Defaults to `gemini-3-flash-preview`. Override via environment variable:
```bash
GEMINI_MODEL=gemini-2.5-flash node server.js
```

## How it works
1. Browser uploads video directly to Gemini Files API (no server bottleneck)
2. Gemini watches the full video — not just frames
3. Returns YAGP-calibrated scores across 6 Technique + 7 Artistry dimensions
4. Specific coaching feedback with exact timestamps (e.g. "0:23 — 0:26")

No video is stored after analysis. Gemini Files API auto-deletes after 48 hours.
