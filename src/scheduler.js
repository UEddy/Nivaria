const cron = require('node-cron');
const { getDb } = require('./db');
const { fetchPageContent, generateDiff } = require('./scraper');
const { analyzeChange } = require('./analyzer');
const { sendAlerts } = require('./webhooks');
const { canUseWebhooks } = require('./payments');

async function checkCompetitor(competitor, db) {
  console.log(`  Checking: ${competitor.name} (${competitor.url})`);

  const { content, hash } = await fetchPageContent(competitor.url);

  db.prepare(`UPDATE competitors SET last_checked = CURRENT_TIMESTAMP, check_count = check_count + 1 WHERE id = ?`)
    .run(competitor.id);

  if (competitor.last_content_hash && competitor.last_content_hash !== hash) {
    console.log(`  ⚡ Change detected: ${competitor.name}`);

    const previousChange = db.prepare(
      `SELECT content_after FROM changes WHERE competitor_id = ? ORDER BY detected_at DESC LIMIT 1`
    ).get(competitor.id);

    const before = previousChange ? JSON.parse(previousChange.content_after) : null;
    const diff = generateDiff(before, content);

    const analysis = await analyzeChange(competitor, before, content, diff);

    const result = db.prepare(`
      INSERT INTO changes (competitor_id, content_before, content_after, diff_summary, analysis, threat_level, recommended_response, talking_points, headline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );

    const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(competitor.user_id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(competitor.user_id);

    if (settings && user && canUseWebhooks(user)) {
      await sendAlerts(settings, competitor, analysis, result.lastInsertRowid);
    }
  }

  db.prepare(`UPDATE competitors SET last_content_hash = ? WHERE id = ?`).run(hash, competitor.id);
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
      console.error(`  ✗ Failed: ${competitor.name} — ${err.message}`);
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

module.exports = { startScheduler, checkCompetitor, runScheduledChecks };
