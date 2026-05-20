const cron = require('node-cron');
const { getDb } = require('./db');
const { fetchPageContent, generateDiff } = require('./scraper');
const { analyzeChange, buildFallbackAnalysis } = require('./analyzer');
const { sendAlerts } = require('./webhooks');
const { canUseWebhooks } = require('./payments');

function fetchErrorToStatus(err) {
  if (err && err.code === 'BLOCKED_PAGE')       return { status: 'blocked',             msg: err.message };
  if (err && err.code === 'EMPTY_CONTENT')      return { status: 'empty_content',       msg: err.message };
  if (err && err.code === 'SELECTOR_NOT_FOUND') return { status: 'selector_not_found',  msg: `Selector "${err.selector}" matched no elements — the page structure may have changed.` };
  const httpStatus = err && err.response && err.response.status;
  if (httpStatus) {
    if (httpStatus === 403) return { status: 'blocked',      msg: `HTTP 403 — likely bot block` };
    if (httpStatus === 404) return { status: 'fetch_failed', msg: `HTTP 404 — page not found` };
    if (httpStatus === 429) return { status: 'fetch_failed', msg: `HTTP 429 — rate limited by site` };
    if (httpStatus >= 500)  return { status: 'fetch_failed', msg: `HTTP ${httpStatus} — site error` };
    return { status: 'fetch_failed', msg: `HTTP ${httpStatus}` };
  }
  if (err && err.code === 'ECONNABORTED') return { status: 'fetch_failed', msg: 'timeout' };
  return { status: 'fetch_failed', msg: (err && err.message) || 'unknown fetch error' };
}

async function checkCompetitor(competitor, db) {
  console.log(`  Checking: ${competitor.name} (${competitor.url})`);

  db.prepare(`UPDATE competitors SET last_checked = CURRENT_TIMESTAMP, check_count = check_count + 1 WHERE id = ?`)
    .run(competitor.id);

  // ── FETCH ────────────────────────────────────────────────────────────────────
  let content, hash;
  try {
    const r = await fetchPageContent(competitor.url, { cssSelector: competitor.css_selector || null });
    content = r.content;
    hash    = r.hash;
  } catch (err) {
    const { status, msg } = fetchErrorToStatus(err);
    console.error(`  ✗ Fetch failed (${status}): ${competitor.name} — ${msg}`);
    db.prepare(`UPDATE competitors SET last_check_status = ?, last_check_error = ?, last_check_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status, msg.slice(0, 500), competitor.id);
    return { ok: false, status, error: msg };
  }

  // ── CHANGE DETECTION ─────────────────────────────────────────────────────────
  const hashChanged = competitor.last_content_hash && competitor.last_content_hash !== hash;
  let changeRowId   = null;
  let analysisStatus = 'ok';
  let analysisError  = null;

  if (hashChanged) {
    console.log(`  ⚡ Change detected: ${competitor.name}`);

    const previousChange = db.prepare(
      `SELECT content_after FROM changes WHERE competitor_id = ? ORDER BY detected_at DESC LIMIT 1`
    ).get(competitor.id);

    const before = previousChange ? JSON.parse(previousChange.content_after) : null;
    const diff = generateDiff(before, content);

    // ── AI ANALYSIS (failure must NOT block persistence) ──────────────────────
    let analysis;
    if (!process.env.ANTHROPIC_API_KEY) {
      analysis = buildFallbackAnalysis(competitor, diff);
      analysisStatus = 'no_ai_key';
      analysisError  = 'ANTHROPIC_API_KEY not configured';
    } else {
      try {
        analysis = await analyzeChange(competitor, before, content, diff);
        analysisStatus = 'ok';
      } catch (aiErr) {
        const code = aiErr.code || 'ai_error';
        const msg  = aiErr.message || String(aiErr);
        console.error(`  ⚠️  AI analysis failed (${code}) for ${competitor.name}: ${msg}`);
        analysis = buildFallbackAnalysis(competitor, diff);
        analysisStatus = code;
        analysisError  = msg.slice(0, 500);
      }
    }

    const insertResult = db.prepare(`
      INSERT INTO changes (competitor_id, content_before, content_after, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, analysis_status, analysis_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      competitor.id,
      previousChange?.content_after || null,
      JSON.stringify(content),
      JSON.stringify(diff),
      JSON.stringify(analysis),
      analysis.threat_level,
      analysis.recommended_response,
      JSON.stringify(analysis.talking_points),
      analysis.headline,
      analysisStatus === 'ok' ? 'ok' : 'failed',
      analysisError,
    );
    changeRowId = insertResult.lastInsertRowid;

    // Alert only when AI analysis is genuine. Rule-based fallbacks would just
    // be noise in Slack/Discord and could be sent later by a backfill job.
    if (analysisStatus === 'ok') {
      const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(competitor.user_id);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(competitor.user_id);
      if (settings && user && canUseWebhooks(user)) {
        try {
          await sendAlerts(settings, competitor, analysis, changeRowId);
        } catch (alertErr) {
          console.error(`  ⚠️  Alert delivery failed for ${competitor.name}: ${alertErr.message}`);
        }
      }
    }
  }

  // ── ALWAYS advance baseline + check status on a successful fetch ────────────
  const finalStatus = !hashChanged
    ? 'ok'
    : analysisStatus === 'ok'
      ? 'ok'
      : `ok_${analysisStatus}`; // e.g. ok_ai_out_of_credits, ok_no_ai_key
  const finalError = analysisStatus === 'ok' ? null : analysisError;

  db.prepare(`UPDATE competitors SET last_content_hash = ?, last_check_status = ?, last_check_error = ?, last_check_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(hash, finalStatus, finalError, competitor.id);

  return { ok: true, status: finalStatus, changed: !!hashChanged, changeRowId };
}

async function runScheduledChecks() {
  const db = getDb();
  const competitors = db.prepare(`
    SELECT c.*, u.tier FROM competitors c
    JOIN users u ON c.user_id = u.id
    WHERE c.active = 1 AND u.tier IN ('pro', 'team')
  `).all();

  if (competitors.length === 0) {
    console.log('⏰ Scheduled check: no eligible competitors');
    return;
  }

  console.log(`\n🔄 Scheduled check: ${competitors.length} competitor(s)...`);

  for (const competitor of competitors) {
    try {
      await checkCompetitor(competitor, db);
    } catch (err) {
      // checkCompetitor now handles its own errors and writes status to DB.
      // Anything reaching here is a true programmer bug or DB failure.
      console.error(`  ✗ Unexpected failure for ${competitor.name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  console.log('✅ Scheduled check complete\n');
}

function startScheduler() {
  // Daily at 9 AM server time
  cron.schedule('0 9 * * *', () => {
    runScheduledChecks().catch(err => console.error('Scheduler error:', err));
  });
  console.log('⏰ Scheduler started — daily checks at 9:00 AM');
}

module.exports = { startScheduler, checkCompetitor, runScheduledChecks, fetchErrorToStatus };
