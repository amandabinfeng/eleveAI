# Élevé AI — Project Context for Claude

## What This App Is
AI-powered ballet performance coaching tool for competitive dancers. Uploads a video, sends it to Gemini for full-video analysis, and returns scored coaching feedback with clickable timestamps.

**Live in:** GitHub Codespaces
**Stack:** Node.js + Express (`server.js`) · Vanilla JS single-page app (`index.html`) · Google Gemini API

---

## Running the App

```bash
# Kill any existing server and restart
pkill -f "node server.js" && node server.js
```

Server runs on port **3001**. Codespaces forwards it automatically.

---

## Architecture

### Frontend (`index.html`)
Single HTML file — all CSS, JS, and HTML in one file. State lives in a global `S` object:

```javascript
S = {
  analysisFile, analysisVideoURL,   // Solo Analysis
  prog1File, prog1VideoURL,          // Progress Tracking — earlier video
  prog2File, prog2VideoURL,          // Progress Tracking — recent video
  style, ageGroup,                   // User settings
  history, lastReport                // Dashboard data (localStorage)
}
```

Views are toggled via `.view` / `.view.active` CSS classes. Navigation handled by `showView(id, navEl)`.

### Server (`server.js`)
Express server. Key endpoints:
- `GET /api/gemini-key` — returns Gemini API key to browser
- `POST /api/gemini-analyze-uri` — solo analysis: receives Gemini file URI, streams NDJSON back
- `POST /api/gemini-compare-uri` — progress comparison: receives 2 file URIs, returns comparison JSON

Gemini model fallback chain: `gemini-3-flash-preview` → `gemini-3.1-flash-lite-preview` → `gemini-2.5-flash`

### Video Upload Flow (Solo Analysis)
1. Browser compresses video with FFmpeg.wasm if > 50MB
2. Browser uploads directly to **Gemini Files API** (bypasses server/nginx size limits)
3. Browser polls until file state = `ACTIVE`
4. Browser sends file URI to `/api/gemini-analyze-uri`
5. Server calls Gemini with the URI, streams result back

### Video Upload Flow (Progress Tracking)
Same compression + direct-to-Gemini-Files upload for both videos, then both URIs sent to `/api/gemini-compare-uri` in one call.

---

## Key Features Built

### Solo Analysis
- Full-video Gemini analysis (not frame-sampling)
- Scores: Overall, Technique (6 dims), Artistry (7 dims)
- Coaching feedback with clickable timestamps → seeks in-page video player
- PDF export via `window.print()` with `@media print` rules
- Dashboard history (localStorage)

### Progress Tracking
- Two-video comparison (earlier vs recent performance)
- Side-by-side video players in results
- Sections: What Improved / Holding Strong / Needs Attention / Focus for Next Training Cycle
- Clickable timestamps on all observations — seek the correct video (earlier or recent)
- PDF export

### Auto Video Compression (FFmpeg.wasm)
- Triggers when file > 50MB
- Compresses to 480p, 24fps, CRF 30, ultrafast preset
- Uses **FFmpeg.wasm v0.11.6** (UMD build via `<script>` tag from unpkg — NOT the ESM v0.12.x)
- Requires `SharedArrayBuffer` → enabled via **COI service worker** (`coi-serviceworker.js`)
  - Codespaces proxy strips COOP/COEP headers, so the SW injects them browser-side
  - On first load: SW registers → page reloads once → `crossOriginIsolated = true`

---

## Important Technical Details

### Timestamp Parsing
Gemini returns timestamps as `0:00:11` (H:MM:SS), not `M:SS`. Use `parseTimestamp()`:
```javascript
function parseTimestamp(t) {
  const p = t.trim().split(':');
  if (p.length === 3) return parseInt(p[0])*3600 + parseInt(p[1])*60 + parseFloat(p[2]);
  if (p.length === 2) return parseInt(p[0])*60 + parseFloat(p[1]);
  return parseFloat(t);
}
```

### Video Seek Reliability
`seekReportVideo` and `seekProgVideo` both:
- Handle `readyState < 1` (wait for `loadedmetadata` event)
- Handle `ended` state (call `vid.pause()` first)
- Silence autoplay-policy errors with `.play().catch(() => {})`

### Video Pause on Navigation
`showView()` pauses all `<video>` elements before switching views — prevents audio continuing in background.

### Blob URLs
Created with `URL.createObjectURL()` — session-only, lost on page refresh. Progress video players are hidden when loading from history (no blob URL available).

---

## Files
| File | Purpose |
|------|---------|
| `index.html` | Entire frontend — CSS, JS, HTML |
| `server.js` | Express backend + Gemini API calls |
| `coi-serviceworker.js` | Injects COOP/COEP headers for SharedArrayBuffer |
| `package.json` | Dependencies: express, @google/generative-ai, multer, cors |
| `.env` | `GEMINI_API_KEY=...` (not committed) |

---

## Known Constraints / Decisions
- **No benchmark feature** — removed, was comparing against reference videos
- **No frame extraction** — old Claude API approach fully replaced by Gemini full-video
- **Same-day videos excluded** from progress tracking (not useful for tracking progress)
- **Variation name** — AI guesses from video rather than using user-entered name (low priority fix)
- **History panel** — blob URLs not available for past analyses, video players hidden in history view
