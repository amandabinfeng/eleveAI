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

let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { console.warn('⚠️  nodemailer not installed — run npm install'); }

let multer, GoogleGenerativeAI, GoogleAIFileManager;
try {
  multer = require('multer');
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  ({ GoogleAIFileManager } = require('@google/generative-ai/server'));
} catch(e) {
  console.warn('⚠️  Gemini dependencies not installed — run npm install');
}

const app               = express();
const PORT              = 3001;
const GEMINI_KEY        = process.env.GEMINI_API_KEY;
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const FALLBACK_QUOTA    = 5;   // used only if DB is unreachable
const GMAIL_USER        = process.env.GMAIL_USER        || 'eleveaicontact@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; // 16-char app password from Google
const ADMIN_EMAIL       = 'eleveaicontact@gmail.com';
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase admin client for JWT verification
let supabaseAdmin;
try {
  const { createClient } = require('@supabase/supabase-js');
  if (SUPABASE_URL && SUPABASE_SVC_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SVC_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
} catch(e) {
  console.warn('⚠️  @supabase/supabase-js not installed — run npm install');
}

// Global default quota — read from Supabase settings table, cached for 60s
let _quotaCache = { value: FALLBACK_QUOTA, expiresAt: 0 };
async function getDefaultQuota() {
  if (Date.now() < _quotaCache.expiresAt) return _quotaCache.value;
  if (!supabaseAdmin) return FALLBACK_QUOTA;
  try {
    const { data } = await supabaseAdmin.from('settings').select('value').eq('key', 'default_quota').single();
    const val = data ? parseInt(data.value, 10) : FALLBACK_QUOTA;
    _quotaCache = { value: isNaN(val) ? FALLBACK_QUOTA : val, expiresAt: Date.now() + 60_000 };
    return _quotaCache.value;
  } catch(e) {
    console.warn('getDefaultQuota error:', e.message);
    return FALLBACK_QUOTA;
  }
}

// Send quota-exceeded notification email to admin via Gmail SMTP (nodemailer).
// Only fires once per 24 h per user to prevent duplicate emails on retries.
async function notifyAdminQuotaExceeded(userId, userEmail, quota) {
  if (!supabaseAdmin || !nodemailer || !GMAIL_APP_PASSWORD) {
    console.log(`[quota] ${userEmail} hit limit (${quota}) — email skipped (GMAIL_APP_PASSWORD not set)`);
    return;
  }
  try {
    // Check last notification timestamp — skip if sent within last 24 h
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('quota_notified_at').eq('id', userId).single();
    const last = profile?.quota_notified_at ? new Date(profile.quota_notified_at).getTime() : 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;

    // Mark as notified before sending (prevents duplicate sends on concurrent retries)
    await supabaseAdmin.from('profiles')
      .update({ quota_notified_at: new Date().toISOString() }).eq('id', userId);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from:    `"Élevé AI" <${GMAIL_USER}>`,
      to:      ADMIN_EMAIL,
      subject: `[Élevé AI] User reached quota — ${userEmail}`,
      text:    `User ${userEmail} has reached their monthly analysis limit of ${quota}.\n\nTo give them more access, log in to the Admin Panel and use "Set Limit" on their row.`,
      html:    `<p>Hi,</p>
                <p>User <strong>${userEmail}</strong> has reached their monthly analysis limit of <strong>${quota}</strong>.</p>
                <p>To give them more access, log in to the <strong>Admin Panel</strong> and use <em>Set Limit</em> on their row.</p>
                <p>— Élevé AI</p>`,
    });
    console.log(`[quota] Admin notified: ${userEmail} hit limit (${quota})`);
  } catch(e) {
    console.warn('[quota] notifyAdmin error:', e.message);
  }
}

// JWT verification middleware — 401 if token missing/invalid
async function verifyAuth(req, res, next) {
  if (!supabaseAdmin) {
    // Supabase not configured — pass through (dev fallback)
    console.warn('⚠️  Supabase not configured — skipping auth check');
    return next();
  }
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const token = auth.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = user;
  next();
}

// Quota middleware — checks monthly usage BEFORE calling Gemini (cost = 1 per call)
function checkQuota(cost = 1) {
  return async function(req, res, next) {
    if (!supabaseAdmin) return next(); // dev fallback: Supabase not configured
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Read per-user override; fall back to global default from settings table
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('monthly_quota').eq('id', userId).single();
    const defaultQuota = await getDefaultQuota();
    const quota = profile?.monthly_quota ?? defaultQuota;

    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    const { count, error: countErr } = await supabaseAdmin
      .from('analyses')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', monthStart)
      .lt('created_at', monthEnd);

    if (countErr) {
      console.error('checkQuota count error:', countErr.message);
      return res.status(500).json({ error: 'Could not verify quota' });
    }
    const used = count ?? 0;
    if (used + cost > quota) {
      // Notify admin async — does not delay the 429 response
      notifyAdminQuotaExceeded(userId, req.user.email || userId, quota);
      return res.status(429).json({
        error:     'quota_exceeded',
        message:   `Monthly limit reached (${quota} analyses). Contact us at eleveaicontact@gmail.com to increase your limit.`,
        used, quota, remaining: Math.max(0, quota - used),
      });
    }
    req.quota = { used, quota, remaining: quota - used };
    next();
  };
}


app.use(cors());
// Required for SharedArrayBuffer (FFmpeg.wasm video compression)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
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
    model: GEMINI_MODEL,
    appUrl: `${proto}://${host}/index.html`,
    isCodespaces: !!process.env.CODESPACE_NAME,
  });
});


// List available Gemini models (for debugging model name issues)
app.get('/api/gemini-models', async (_, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
    const d = await r.json();
    const models = (d.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name);
    res.json({ models });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Expose Gemini key to frontend (for direct browser→Gemini upload, bypassing nginx 413 limit)
app.get('/api/gemini-key', (_, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
  res.json({ key: GEMINI_KEY });
});

// Expose Supabase public config to frontend (anon key is designed to be public)
app.get('/api/supabase-config', (_, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: 'Supabase not configured — add SUPABASE_URL and SUPABASE_ANON_KEY to environment secrets' });
  }
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// ── Quota & Admin endpoints ───────────────────────────────────────────────────

// User: fetch own quota status for this calendar month
app.get('/api/quota-status', verifyAuth, async (req, res) => {
  const defaultQuota = await getDefaultQuota();
  if (!supabaseAdmin) return res.json({ used: 0, quota: defaultQuota, remaining: defaultQuota });
  const userId = req.user.id;
  const { data: profile } = await supabaseAdmin.from('profiles').select('monthly_quota').eq('id', userId).single();
  const quota = profile?.monthly_quota ?? defaultQuota;
  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const { count }  = await supabaseAdmin.from('analyses')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).gte('created_at', monthStart).lt('created_at', monthEnd);
  const used = count ?? 0;
  res.json({ used, quota, remaining: quota - used });
});

// Admin: per-user monthly usage stats for invoicing
app.get('/api/admin/usage', verifyAuth, async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
  const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).single();
  if (caller?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const defaultQuota = await getDefaultQuota();
  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const month      = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const [{ data: profiles }, { data: monthlyRows }, { data: allRows }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id,email,role,monthly_quota,created_at').order('created_at'),
    supabaseAdmin.from('analyses').select('user_id,type').gte('created_at', monthStart).lt('created_at', monthEnd),
    supabaseAdmin.from('analyses').select('user_id'),
  ]);

  const monthMap = {}, soloMap = {}, progMap = {}, allMap = {};
  (monthlyRows || []).forEach(a => {
    monthMap[a.user_id] = (monthMap[a.user_id] || 0) + 1;
    if (a.type === 'solo')     soloMap[a.user_id] = (soloMap[a.user_id] || 0) + 1;
    if (a.type === 'progress') progMap[a.user_id]  = (progMap[a.user_id]  || 0) + 1;
  });
  (allRows || []).forEach(a => { allMap[a.user_id] = (allMap[a.user_id] || 0) + 1; });

  res.json({
    month, defaultQuota: defaultQuota,
    users: (profiles || []).map(p => ({
      id: p.id, email: p.email, role: p.role,
      quota:          p.monthly_quota ?? defaultQuota,
      quotaOverride:  p.monthly_quota !== null,
      thisMonth:      monthMap[p.id] || 0,
      soloThisMonth:  soloMap[p.id]  || 0,
      progressThisMonth: progMap[p.id] || 0,
      allTime:        allMap[p.id]   || 0,
      joined:         p.created_at,
    })),
  });
});

// Admin: set one user's monthly quota (null = revert to server default)
app.post('/api/admin/set-quota', verifyAuth, express.json({ limit: '1kb' }), async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
  const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).single();
  if (caller?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { targetUserId, quota } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (quota !== null && (typeof quota !== 'number' || quota < 0))
    return res.status(400).json({ error: 'quota must be a non-negative integer or null' });
  const { error } = await supabaseAdmin.from('profiles').update({ monthly_quota: quota }).eq('id', targetUserId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Admin: bulk reset — set monthly_quota for ALL non-admin users at once
app.post('/api/admin/set-quota-all', verifyAuth, express.json({ limit: '1kb' }), async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
  const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).single();
  if (caller?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { quota } = req.body;
  if (typeof quota !== 'number' || quota < 0)
    return res.status(400).json({ error: 'quota must be a non-negative integer' });
  const { error, count } = await supabaseAdmin
    .from('profiles').update({ monthly_quota: quota }).neq('role', 'admin');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, updatedCount: count });
});

// Admin: read current global settings (default_quota, etc.)
app.get('/api/admin/settings', verifyAuth, async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
  const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).single();
  if (caller?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { data, error } = await supabaseAdmin.from('settings').select('key,value');
  if (error) return res.status(500).json({ error: error.message });
  const obj = {};
  (data || []).forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

// Admin: update the global default quota for all new / uncustomised users
app.post('/api/admin/set-default-quota', verifyAuth, express.json({ limit: '1kb' }), async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase not configured' });
  const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', req.user.id).single();
  if (caller?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { quota } = req.body;
  if (typeof quota !== 'number' || quota < 0)
    return res.status(400).json({ error: 'quota must be a non-negative integer' });
  const { error } = await supabaseAdmin
    .from('settings')
    .upsert({ key: 'default_quota', value: String(quota), updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  // Bust the in-memory cache so next quota check picks up the new value immediately
  _quotaCache.expiresAt = 0;
  console.log(`[admin] Default quota updated to ${quota}`);
  res.json({ ok: true, defaultQuota: quota });
});

// ── Gemini analysis by URI — browser uploads file directly to Gemini, sends us just the URI
if (GoogleGenerativeAI) {
  app.post('/api/gemini-analyze-uri', verifyAuth, checkQuota(1), express.json({ limit: '1mb' }), async (req, res) => {
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
        'Pre-competitive': `DIVISION: Pre-competitive.
CRITICAL — SCORE RELATIVE TO DIVISION: Do NOT apply Junior or Senior standards. Score against Pre-competitive peers only.
The choreography is simpler by design — never deduct for variation difficulty.
YAGP PRE-COMPETITIVE SCORING ANCHORS:
- 90–96: Clean natural posture, turnout from hip (not forced), soft correct arms, stays on music, genuine stage presence. Small errors are normal and expected.
- 85–89: Good foundations with some inconsistency in alignment or turnout.
- Below 80: Significant technical safety concerns or inability to stay with the music.
A dancer with natural technique, musicality, and age-appropriate expression SHOULD score 88–94. Do not be conservative.
FOCUS: Natural plumb line, relaxed arms, hip-initiated turnout, musicality, warm stage presence.`,

        'Junior': `DIVISION: Junior.
CRITICAL — SCORE RELATIVE TO DIVISION: Score against Junior competition peers at YAGP, not Senior or professional standards.
YAGP JUNIOR SCORING ANCHORS:
- 90–96: Controlled pirouettes, proper jump preparation and landing, safe and functional pointework, emerging épaulement, clear phrasing awareness. Minor imperfections acceptable.
- 85–89: Solid technique with inconsistency in turns or jumps.
- Below 80: Repeated technical errors or safety concerns in pointework/landings.
A well-prepared Junior with controlled technique and musical sensitivity SHOULD score 88–94.
FOCUS: Pirouette control, jump prep/landing, safe pointework, emerging épaulement, phrasing.`,

        'Senior': `DIVISION: Senior.
CRITICAL — SCORE RELATIVE TO DIVISION: Score against Senior YAGP/international competitors.
YAGP SENIOR SCORING ANCHORS:
- 98–100: World-class — Prix de Lausanne / international grand prix finalist level. Near-flawless execution, profound artistic depth, professional stage command.
- 96–97: YAGP Finals qualifying standard. Exceptional technique, genuine artistry, stylistic authenticity. Top performers invited to finals.
- 91–95: YAGP strong regional — top 12 placement. Solid technique with real artistry and only minor inconsistencies.
- 86–90: Competitive regional level. Good foundations with developing artistry.
- Below 86: Significant technical gaps or performance lacking stylistic identity.
A well-prepared Senior placing top 12 at YAGP regional should score 91–95. Finals = 96–97. Prix de Lausanne calibre = 98+. Do not compress all good performances into a narrow band.
FOCUS: Stylistic authenticity, genuine artistry through the steps, technical consistency.`,
      };

      const prompt = `Act as a professional Ballet Adjudicator and Technical Coach with 20+ years of YAGP competition experience.

Watch this full ballet performance video from start to finish. You are seeing continuous movement — assess the complete arc of every jump (including peak height and ballon), full rotations of turns from preparation to landing, quality of transitions, and dynamic flow across the entire variation. Note specific timestamps (m:ss) for every observation.

Ballet style: ${style}.${desc ? ' Dancer context: ' + desc : ''}
${ageFocusMap[ageGroup] || ageFocusMap['Junior']}

Perform a high-precision technical audit using standard ballet terminology (en dehors, plié, allongé, épaulement, ballon, port de bras, arabesque, etc.):

ALIGNMENT & PLACEMENT: Evaluate verticality of the spine, stability of the supporting leg, squareness of hips and shoulders during transitions and held positions.

TURNOUT & LINE: Track rotation specifically from the hip sockets (en dehors) — not the ankles or knees. Critique the line in arabesque, attitude, and the height/extension of the working leg.

FOOTWORK & JUMPS: Analyze articulation through the feet (rolling through the floor in pliés and relevés), ballon and buoyancy in jumps, and whether landings are controlled and silent.

SPATIAL AWARENESS: Comment on use of stage space, clarity of épaulement (head/shoulder placement), and precision of the dancer's track during traveling steps.

ARTISTRY: Assess port de bras quality and flow, dynamic contrast (fast/slow, light/heavy, tension/release), authentic expression, and stage presence.

Score using the YAGP two-pillar system. Each pillar 0–100. Overall = average of both.

TECHNIQUE (each 0–100): alignment, turnout, execution, pointework, musicality, control
ARTISTRY (each 0–100): line, epaulement, portDeBras, style, dynamics, presence, expression

Return ONLY valid JSON (no markdown, no extra text):
{"techniqueScore":<0-100>,"artistryScore":<0-100>,"overallScore":<average rounded>,"technique":{"alignment":<0-100>,"turnout":<0-100>,"execution":<0-100>,"pointework":<0-100>,"musicality":<0-100>,"control":<0-100>},"artistry":{"line":<0-100>,"epaulement":<0-100>,"portDeBras":<0-100>,"style":<0-100>,"dynamics":<0-100>,"presence":<0-100>,"expression":<0-100>},"pose":"<variation name>","positives":[{"text":"<specific observation using ballet terminology>","timeStart":"<m:ss>","timeEnd":"<m:ss>"}],"improvements":[{"text":"<actionable correction with specific ballet term>","timeStart":"<m:ss>","timeEnd":"<m:ss>"}],"coachNote":"<2-3 sentences with 3 actionable rehearsal corrections using ballet terminology>"}
4-5 positives, 4-5 improvements. Be specific and reference exact timestamps for each.`;

      const genAI = new GoogleGenerativeAI(GEMINI_KEY);
      const FALLBACK_MODELS = [GEMINI_MODEL, 'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash'];
      let text, usedModel;
      for (const modelId of FALLBACK_MODELS) {
        try {
          console.log(`Trying model: ${modelId}`);
          const model = genAI.getGenerativeModel({ model: modelId, generationConfig: { maxOutputTokens: 4000 } });
          const result = await model.generateContent([{ fileData: { fileUri, mimeType } }, { text: prompt }]);
          text = result.response.text();
          usedModel = modelId;
          console.log(`✓ Gemini analysis done (model: ${usedModel})`);
          break;
        } catch (modelErr) {
          const is503 = modelErr.message?.includes('503') || modelErr.message?.includes('Service Unavailable') || modelErr.message?.includes('high demand');
          if (is503 && modelId !== FALLBACK_MODELS[FALLBACK_MODELS.length - 1]) {
            console.warn(`⚠️  ${modelId} unavailable (503), trying fallback...`);
            continue;
          }
          throw modelErr;
        }
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Gemini returned no JSON: ' + text.slice(0, 200));

      send({ status: 'done', result: JSON.parse(jsonMatch[0]), usedFallback: usedModel !== GEMINI_MODEL, usedModel });
      res.end();
    } catch (err) {
      console.error('Gemini URI analysis error:', err.message);
      send({ status: 'error', error: err.message });
      res.end();
    }
  });

  // Progress comparison — receives two Gemini file URIs, compares both videos in one call
  app.post('/api/gemini-compare-uri', verifyAuth, checkQuota(1), express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const {
        fileUri1, mimeType1 = 'video/mp4',
        fileUri2, mimeType2 = 'video/mp4',
        context1 = 'Earlier performance', context2 = 'Recent performance',
        ageGroup = 'Junior', style = 'Classical', variationName = ''
      } = req.body;
      if (!fileUri1 || !fileUri2) throw new Error('Both fileUri1 and fileUri2 are required');
      if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');

      const ageFocusMap = {
        'Pre-competitive': `DIVISION: Pre-competitive. Score against Pre-competitive peers only. Choreography is simpler by design.
SCORING ANCHORS: 90–96: clean posture, hip-initiated turnout, stays on music, genuine presence. 85–89: good foundations with inconsistency. Below 80: safety concerns.`,
        'Junior': `DIVISION: Junior. Score against Junior YAGP peers.
SCORING ANCHORS: 90–96: controlled pirouettes, safe pointework, emerging épaulement, musical phrasing. 85–89: solid with inconsistency. Below 80: repeated errors.`,
        'Senior': `DIVISION: Senior. Score against Senior YAGP/international competitors.
SCORING ANCHORS: 96–97: YAGP Finals standard. 91–95: strong regional top 12. 86–90: competitive regional. Below 86: significant gaps.`,
      };

      const pointeworkLabel = ageGroup === 'Pre-competitive' ? 'demi-pointe' : 'pointework';

      const prompt = `Act as a professional Ballet Adjudicator with 20+ years of YAGP experience.

You are watching TWO performances of ${variationName || 'the same variation'} by the same dancer at different points in time.

VIDEO 1 — EARLIER performance: ${context1}
VIDEO 2 — RECENT performance: ${context2}

Ballet style: ${style}.
${ageFocusMap[ageGroup] || ageFocusMap['Junior']}

Watch both videos in full. Score EACH performance independently on all 13 YAGP dimensions (0–100):
TECHNIQUE: alignment, turnout, execution, ${pointeworkLabel}, musicality, control
ARTISTRY: line, epaulement, portDeBras, style, dynamics, presence, expression

Then compare: identify what specifically improved, what stayed consistent, and what regressed between the two performances. Use ballet terminology. For EVERY observation, note the exact timestamp (m:ss) in the earlier video AND the exact timestamp in the recent video where the difference is most visible.

Return ONLY valid JSON (no markdown):
{
  "earlier":{"techniqueScore":<N>,"artistryScore":<N>,"technique":{"alignment":<N>,"turnout":<N>,"execution":<N>,"pointework":<N>,"musicality":<N>,"control":<N>},"artistry":{"line":<N>,"epaulement":<N>,"portDeBras":<N>,"style":<N>,"dynamics":<N>,"presence":<N>,"expression":<N>}},
  "recent":{"techniqueScore":<N>,"artistryScore":<N>,"technique":{"alignment":<N>,"turnout":<N>,"execution":<N>,"pointework":<N>,"musicality":<N>,"control":<N>},"artistry":{"line":<N>,"epaulement":<N>,"portDeBras":<N>,"style":<N>,"dynamics":<N>,"presence":<N>,"expression":<N>}},
  "verdict":"improved"|"maintained"|"regressed",
  "rationale":"<one sentence overall summary>",
  "improved":[{"area":"<dimension or skill>","observation":"<specific observation — do NOT embed timestamps in the text>","timeEarlier":"<m:ss>","timeRecent":"<m:ss>"}],
  "maintained":[{"area":"<...>","observation":"<...>","timeEarlier":"<m:ss>","timeRecent":"<m:ss>"}],
  "regressed":[{"area":"<...>","observation":"<...>","timeEarlier":"<m:ss>","timeRecent":"<m:ss>"}],
  "focusAreas":["<specific coaching priority 1 with timestamp if relevant, e.g. focus on the arabesque at 0:45>","<priority 2>","<priority 3>"]
}`;

      const genAI = new GoogleGenerativeAI(GEMINI_KEY);
      const FALLBACK_MODELS = [GEMINI_MODEL, 'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash'];
      let text, usedModel;
      for (const modelId of FALLBACK_MODELS) {
        try {
          console.log(`Trying model for comparison: ${modelId}`);
          const model = genAI.getGenerativeModel({ model: modelId, generationConfig: { maxOutputTokens: 5000 } });
          const result = await model.generateContent([
            { fileData: { fileUri: fileUri1, mimeType: mimeType1 } },
            { fileData: { fileUri: fileUri2, mimeType: mimeType2 } },
            { text: prompt }
          ]);
          text = result.response.text();
          usedModel = modelId;
          console.log(`✓ Gemini comparison done (model: ${usedModel})`);
          break;
        } catch (modelErr) {
          const is503 = modelErr.message?.includes('503') || modelErr.message?.includes('Service Unavailable') || modelErr.message?.includes('high demand');
          if (is503 && modelId !== FALLBACK_MODELS[FALLBACK_MODELS.length - 1]) {
            console.warn(`⚠️  ${modelId} unavailable, trying fallback…`);
            continue;
          }
          throw modelErr;
        }
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Gemini returned no JSON: ' + text.slice(0, 200));

      res.json({ result: JSON.parse(jsonMatch[0]), usedFallback: usedModel !== GEMINI_MODEL, usedModel });
    } catch (err) {
      console.error('Gemini compare error:', err.message);
      res.status(500).json({ error: err.message });
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
        'Pre-competitive': `DIVISION: Pre-competitive.
CRITICAL — SCORE RELATIVE TO DIVISION: Do NOT apply Junior or Senior standards. Score against Pre-competitive peers only.
The choreography is simpler by design — never deduct for variation difficulty.
YAGP PRE-COMPETITIVE SCORING ANCHORS:
- 90–96: Clean natural posture, turnout from hip (not forced), soft correct arms, stays on music, genuine stage presence. Small errors are normal and expected.
- 85–89: Good foundations with some inconsistency in alignment or turnout.
- Below 80: Significant technical safety concerns or inability to stay with the music.
A dancer with natural technique, musicality, and age-appropriate expression SHOULD score 88–94. Do not be conservative.
FOCUS: Natural plumb line, relaxed arms, hip-initiated turnout, musicality, warm stage presence.`,

        'Junior': `DIVISION: Junior.
CRITICAL — SCORE RELATIVE TO DIVISION: Score against Junior competition peers at YAGP, not Senior or professional standards.
YAGP JUNIOR SCORING ANCHORS:
- 90–96: Controlled pirouettes, proper jump preparation and landing, safe and functional pointework, emerging épaulement, clear phrasing awareness. Minor imperfections acceptable.
- 85–89: Solid technique with inconsistency in turns or jumps.
- Below 80: Repeated technical errors or safety concerns in pointework/landings.
A well-prepared Junior with controlled technique and musical sensitivity SHOULD score 88–94.
FOCUS: Pirouette control, jump prep/landing, safe pointework, emerging épaulement, phrasing.`,

        'Senior': `DIVISION: Senior.
CRITICAL — SCORE RELATIVE TO DIVISION: Score against Senior YAGP/international competitors.
YAGP SENIOR SCORING ANCHORS:
- 98–100: World-class — Prix de Lausanne / international grand prix finalist level. Near-flawless execution, profound artistic depth, professional stage command.
- 96–97: YAGP Finals qualifying standard. Exceptional technique, genuine artistry, stylistic authenticity. Top performers invited to finals.
- 91–95: YAGP strong regional — top 12 placement. Solid technique with real artistry and only minor inconsistencies.
- 86–90: Competitive regional level. Good foundations with developing artistry.
- Below 86: Significant technical gaps or performance lacking stylistic identity.
A well-prepared Senior placing top 12 at YAGP regional should score 91–95. Finals = 96–97. Prix de Lausanne calibre = 98+. Do not compress all good performances into a narrow band.
FOCUS: Stylistic authenticity, genuine artistry through the steps, technical consistency.`,
      };

      const prompt = `Act as a professional Ballet Adjudicator and Technical Coach with 20+ years of YAGP competition experience.

Watch this full ballet performance video from start to finish. You are seeing continuous movement — assess the complete arc of every jump (including peak height and ballon), full rotations of turns from preparation to landing, quality of transitions, and dynamic flow across the entire variation. Note specific timestamps (m:ss) for every observation.

Ballet style: ${style}.${desc ? ' Dancer context: ' + desc : ''}
${ageFocusMap[ageGroup] || ageFocusMap['Junior']}

Perform a high-precision technical audit using standard ballet terminology (en dehors, plié, allongé, épaulement, ballon, port de bras, arabesque, etc.):

ALIGNMENT & PLACEMENT: Evaluate verticality of the spine, stability of the supporting leg, squareness of hips and shoulders during transitions and held positions.

TURNOUT & LINE: Track rotation specifically from the hip sockets (en dehors) — not the ankles or knees. Critique the line in arabesque, attitude, and the height/extension of the working leg.

FOOTWORK & JUMPS: Analyze articulation through the feet (rolling through the floor in pliés and relevés), ballon and buoyancy in jumps, and whether landings are controlled and silent.

SPATIAL AWARENESS: Comment on use of stage space, clarity of épaulement (head/shoulder placement), and precision of the dancer's track during traveling steps.

ARTISTRY: Assess port de bras quality and flow, dynamic contrast (fast/slow, light/heavy, tension/release), authentic expression, and stage presence.

Score using the YAGP two-pillar system. Each pillar 0–100. Overall = average of both.

TECHNIQUE (each 0–100): alignment, turnout, execution, pointework, musicality, control
ARTISTRY (each 0–100): line, epaulement, portDeBras, style, dynamics, presence, expression

Return ONLY valid JSON (no markdown, no extra text):
{"techniqueScore":<0-100>,"artistryScore":<0-100>,"overallScore":<average rounded>,"technique":{"alignment":<0-100>,"turnout":<0-100>,"execution":<0-100>,"pointework":<0-100>,"musicality":<0-100>,"control":<0-100>},"artistry":{"line":<0-100>,"epaulement":<0-100>,"portDeBras":<0-100>,"style":<0-100>,"dynamics":<0-100>,"presence":<0-100>,"expression":<0-100>},"pose":"<variation name>","positives":[{"text":"<specific observation using ballet terminology>","timeStart":"<m:ss>","timeEnd":"<m:ss>"}],"improvements":[{"text":"<actionable correction with specific ballet term>","timeStart":"<m:ss>","timeEnd":"<m:ss>"}],"coachNote":"<2-3 sentences with 3 actionable rehearsal corrections using ballet terminology>"}
4-5 positives, 4-5 improvements. Be specific and reference exact timestamps for each.`;

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
    console.log(`│  Gemini API key:  ${GEMINI_KEY ? 'loaded ✓' : '⚠️  NOT SET — add GEMINI_API_KEY in Codespaces Secrets'}`);
    console.log(`│  Supabase:        ${SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SVC_KEY ? 'configured ✓' : '⚠️  NOT SET — add SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'}`);
    console.log('└─────────────────────────────────────────────────────────────────┘\n');
  } else {
    console.log('\n┌──────────────────────────────────────────────────────┐');
    console.log('│           Élevé AI  —  Local Proxy Server            │');
    console.log('├──────────────────────────────────────────────────────┤');
    console.log(`│  Open:  http://localhost:${PORT}/index.html  │`);
    console.log(`│  Gemini API key: ${GEMINI_KEY ? 'loaded ✓' : '⚠️  NOT SET — add GEMINI_API_KEY'}  │`);
    console.log('└──────────────────────────────────────────────────────┘\n');
  }
});
