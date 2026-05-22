const cron = require('node-cron');
const { getDb } = require('./db');
const { fetchPageContent, generateDiff } = require('./scraper');
const { analyzeChange, buildFallbackAnalysis, estimateCostUsd } = require('./analyzer');
const { classifyChange } = require('./changeGate');
const { sendAlerts } = require('./webhooks');
const { canUseWebhooks } = require('./payments');
const { getCompetitorHistory, invalidateCompetitorHistory } = require('./historicalContext');

function fetchErrorToStatus(err) {
  if (err && err.code === 'BLOCKED_PAGE')       return { status: 'blocked',             msg: err.message };
  if (err && err.code === 'EMPTY_CONTENT')      return { status: 'empty_content',       msg: err.message };
  if (err && err.code === 'SELECTOR_NOT_FOUND') return { status: 'selector_not_found',  msg: `Selector "${err.selector}" matched no elements — the page structure may have changed.` };
  if (err && err.code === 'SSRF_BLOCKED')       return { status: 'ssrf_blocked',        msg: err.message };
  if (err && err.code === 'RENDER_FAILED')      return { status: 'render_failed',       msg: err.message };
  const httpStatus = err && err.response && err.response.status;
  if (httpStatus) {
    if (httpStatus === 403) return { status: 'blocked',      msg: `HTTP 403 — likely bot block` };
    if (httpStatus === 404) return { status: 'fetch_failed', msg: `HTTP 404 — page not found` };
    if (httpStatus === 429) return { status: 'fetch_failed', msg: `HTTP 429 — rate limited by site` };
    if (httpStatus >= 500)  return { status: 'fetch_failed', msg: `HTTP ${httpStatus} — site error` };
    return { status: 'fetch_failed', msg: `HTTP ${httpStatus}` };
  }
  if (err && err.code === 'ECONNABORTED') return { status: 'fetch_failed', msg: 'timeout' };
  // Playwright navigation timeouts surface as TimeoutError with a name field.
  if (err && (err.name === 'TimeoutError' || /Timeout.*exceeded/i.test(err.message || ''))) {
    return { status: 'render_failed', msg: 'render timeout (30s)' };
  }
  return { status: 'fetch_failed', msg: (err && err.message) || 'unknown fetch error' };
}

async function checkCompetitor(competitor, db) {
  const renderMode = competitor.render_mode === 'js' ? 'js' : 'fetch';
  console.log(`  Checking: ${competitor.name} (${competitor.url}) [render=${renderMode}]`);

  db.prepare(`UPDATE competitors SET last_checked = CURRENT_TIMESTAMP, check_count = check_count + 1 WHERE id = ?`)
    .run(competitor.id);

  // ── FETCH ────────────────────────────────────────────────────────────────────
  let content, hash, renderDuration;
  try {
    const r = await fetchPageContent(competitor.url, {
      cssSelector: competitor.css_selector || null,
      renderMode,
    });
    content        = r.content;
    hash           = r.hash;
    renderDuration = r.renderDuration;
    console.log(`  ⏱  render=${renderMode} duration=${renderDuration}ms`);
  } catch (err) {
    const { status, msg } = fetchErrorToStatus(err);
    console.error(`  ✗ Fetch failed (${status}, render=${renderMode}): ${competitor.name} — ${msg}`);
    db.prepare(`UPDATE competitors SET last_check_status = ?, last_check_error = ?, last_check_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status, msg.slice(0, 500), competitor.id);
    return { ok: false, status, error: msg };
  }

  // ── CHANGE DETECTION ─────────────────────────────────────────────────────────
  const hashChanged = competitor.last_content_hash && competitor.last_content_hash !== hash;
  let changeRowId   = null;
  let analysisStatus = 'ok';
  let analysisError  = null;

  let isMeaningful = 1;
  let gateCategory = null;
  let gateReason   = null;
  let aiInputTokens  = null;
  let aiOutputTokens = null;
  let patternTagsJson      = null;
  let historicalContextStr = null;

  if (hashChanged) {
    console.log(`  ⚡ Change detected: ${competitor.name}`);

    const previousChange = db.prepare(
      `SELECT content_after FROM changes WHERE competitor_id = ? ORDER BY detected_at DESC LIMIT 1`
    ).get(competitor.id);

    const before = previousChange ? JSON.parse(previousChange.content_after) : null;
    const diff = generateDiff(before, content);

    // ── GATE: classify cheaply before spending an AI call ───────────────────
    const gate = classifyChange(before, content, diff);
    gateCategory = gate.category;
    gateReason   = gate.reason;
    console.log(`  🚪 Gate: ${gate.meaningful ? 'MEANINGFUL' : 'trivial'} (${gate.category}) — ${gate.reason}`);

    let analysis;
    if (!gate.meaningful) {
      // Skip the AI entirely. Persist a thin record so the user can still
      // see what was gated if they enable the trivial filter, but no
      // webhook is fired and no tokens are spent.
      isMeaningful = 0;
      analysis = buildTrivialAnalysis(competitor, gate);
      analysisStatus = 'trivial';
    } else if (!process.env.ANTHROPIC_API_KEY) {
      analysis = buildFallbackAnalysis(competitor, diff);
      analysisStatus = 'no_ai_key';
      analysisError  = 'ANTHROPIC_API_KEY not configured';
    } else {
      // Phase 5: pull the competitor's recent history so the AI can reference
      // patterns ("third pricing change this quarter") instead of analyzing
      // each diff in isolation. Failures here must NEVER block the AI call —
      // we degrade silently to a history-less prompt.
      let historyText = '';
      let historyMeta = { count: 0, cacheHit: false, included: false, skipReason: null };
      try {
        const hist = getCompetitorHistory(competitor.id, { userId: competitor.user_id });
        historyText = hist.formatted;
        historyMeta = {
          count: hist.count,
          cacheHit: hist.cacheHit,
          included: hist.count > 0,
          skipReason: hist.count === 0 ? 'no_prior_changes' : null,
        };
      } catch (histErr) {
        historyMeta.skipReason = `history_fetch_failed: ${histErr.message}`;
        console.warn(`  ⚠️  History fetch failed for ${competitor.name}: ${histErr.message}`);
      }
      console.log(`  📜 History: ${historyMeta.included
        ? `${historyMeta.count} prior changes included${historyMeta.cacheHit ? ' (cached)' : ''}`
        : `skipped (${historyMeta.skipReason})`}`);

      try {
        const result = await analyzeChange(competitor, before, content, diff, historyText);
        analysis = result.analysis;
        analysisStatus = 'ok';
        if (result.usage) {
          aiInputTokens  = result.usage.input_tokens;
          aiOutputTokens = result.usage.output_tokens;
          const cost = estimateCostUsd(result.usage);
          console.log(`  💰 AI usage: in=${aiInputTokens} out=${aiOutputTokens} ≈$${cost.toFixed(4)}${historyMeta.included ? ` [+history: ${historyMeta.count} rows]` : ''}`);
        }
        // Persist Phase 5 fields if the AI produced them.
        if (Array.isArray(analysis.pattern_tags) && analysis.pattern_tags.length > 0) {
          patternTagsJson = JSON.stringify(analysis.pattern_tags);
        }
        if (typeof analysis.historical_context === 'string' && analysis.historical_context.trim()) {
          historicalContextStr = analysis.historical_context.trim().slice(0, 1000);
        }
        // Post-hoc downgrade: AI looked at the diff and decided there was
        // nothing of strategic significance. Treat exactly like a gated row —
        // record stays for transparency, but no webhook fires.
        if (analysis.is_meaningful === false) {
          isMeaningful = 0;
          gateCategory = 'ai_downgraded';
          gateReason   = analysis.why_it_matters || 'AI judged change as non-meaningful';
          console.log(`  🚪 AI post-hoc downgrade: ${gateReason}`);
        }
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
      INSERT INTO changes (competitor_id, content_before, content_after, diff_summary, analysis, threat_level, recommended_response, talking_points, headline, analysis_status, analysis_error, is_meaningful, gate_category, gate_reason, ai_input_tokens, ai_output_tokens, pattern_tags, historical_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      competitor.id,
      previousChange?.content_after || null,
      JSON.stringify(content),
      JSON.stringify(diff),
      JSON.stringify(analysis),
      analysis.threat_level,
      analysis.recommended_response,
      JSON.stringify(analysis.talking_points || []),
      analysis.headline,
      analysisStatus === 'ok' ? 'ok' : (analysisStatus === 'trivial' ? 'trivial' : 'failed'),
      analysisError,
      isMeaningful,
      gateCategory,
      gateReason ? gateReason.slice(0, 500) : null,
      aiInputTokens,
      aiOutputTokens,
      patternTagsJson,
      historicalContextStr,
    );
    changeRowId = insertResult.lastInsertRowid;

    // Phase 5: drop cached history for this competitor so the next analysis
    // (manual or scheduled) picks up this change instead of serving stale data.
    invalidateCompetitorHistory(competitor.id);

    // Alert only when (a) AI analysis succeeded, AND (b) the change is
    // meaningful (gate + AI both agree it's worth a sales team's attention).
    if (analysisStatus === 'ok' && isMeaningful === 1) {
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
  // Gated-trivial counts as 'ok' for the competitor's check status — the
  // pipeline ran exactly as intended; we just chose not to call the AI.
  const finalStatus = !hashChanged
    ? 'ok'
    : (analysisStatus === 'ok' || analysisStatus === 'trivial')
      ? 'ok'
      : `ok_${analysisStatus}`; // e.g. ok_ai_out_of_credits, ok_no_ai_key
  const finalError = (analysisStatus === 'ok' || analysisStatus === 'trivial') ? null : analysisError;

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

// Stub analysis returned when the gate classifies a diff as trivial. We never
// call Anthropic, but we still write a row so users can audit gating decisions
// from the UI via the "Trivial" filter.
function buildTrivialAnalysis(competitor, gate) {
  return {
    is_meaningful: false,
    changed_what: `${competitor.name} page changed in a way that did not require analysis`,
    why_it_matters: `Gated as trivial: ${gate.reason}`,
    threat_level: 'low',
    threat_reasoning: `Pre-AI gate classified this change as "${gate.category}".`,
    recommended_response: 'No action needed.',
    talking_points: [],
    headline: `${competitor.name} — trivial change skipped`,
    summary: `Change detected but classified by the pre-AI gate as "${gate.category}": ${gate.reason}. No battle card generated.`,
    key_changes: [{ category: 'other', description: gate.reason, impact: 'None — gated as trivial' }],
    opportunity: '',
  };
}

module.exports = { startScheduler, checkCompetitor, runScheduledChecks, fetchErrorToStatus, buildTrivialAnalysis };
