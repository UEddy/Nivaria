// Phase 9 verification — win/loss correlation engine, deal logging (manual +
// Slack), and the ROI dashboard. Runs the 7 required tests, prints a report,
// writes phase9-report.json, and cleans up all test rows it creates.
//
// Module-level tests run in-process (deterministic). The Slack signature test
// (Test 3) also hits the LIVE server endpoint to prove the real route rejects
// unsigned/forged requests with 401 and accepts a correctly signed one.

require('dotenv').config();
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { initDb, getDb } = require('./src/db');
const deals  = require('./src/deals');
const engine = require('./src/correlationEngine');
const slack  = require('./src/slackCommands');

const BASE = 'http://localhost:3000';
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'local_test_signing_secret_phase9';

const report = { tests: {}, started: new Date().toISOString() };
let pass = 0, fail = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function createUser(db, name) {
  const email = `phase9_${uuidv4().slice(0, 8)}@test.local`;
  const apiKey = 'cs-' + uuidv4().replace(/-/g, '');
  const id = db.prepare("INSERT INTO users (email, name, tier, api_key) VALUES (?, ?, 'pro', ?)").run(email, name, apiKey).lastInsertRowid;
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(id);
  return id;
}
function createCompetitor(db, userId, name) {
  return db.prepare("INSERT INTO competitors (user_id, name, url) VALUES (?, ?, ?)")
    .run(userId, name, `https://${name.toLowerCase().replace(/\s+/g, '')}.com`).lastInsertRowid;
}
function dayStr(daysAgo) {
  return new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);
}
function tsStr(daysAgo) {
  return new Date(Date.now() - daysAgo * 864e5).toISOString().replace('T', ' ').slice(0, 19);
}
function insertPricingChange(db, competitorId, daysAgo) {
  const analysis = JSON.stringify({
    is_meaningful: true, threat_level: 'high', headline: 'Pricing change',
    key_changes: [{ category: 'pricing', description: 'Repriced plans', impact: 'pressure' }],
  });
  return db.prepare(`
    INSERT INTO changes (competitor_id, analysis, threat_level, headline, analysis_status, is_meaningful, gate_category, pattern_tags, detected_at)
    VALUES (?, ?, 'high', 'Pricing change', 'ok', 1, 'pricing_pattern', ?, ?)
  `).run(competitorId, analysis, JSON.stringify(['pricing_change']), tsStr(daysAgo)).lastInsertRowid;
}

function httpPost(urlPath, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request({
      method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(rawBody), ...headers },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

(async () => {
  await initDb();
  const db = getDb();
  const createdUsers = [];
  const createdCompetitors = [];

  try {
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 1: Manual form — log 3 deals (1 won, 2 lost vs tracked) ──');
    const userA = createUser(db, 'Phase9 A'); createdUsers.push(userA);
    const compAcme = createCompetitor(db, userA, 'AcmeX'); createdCompetitors.push(compAcme);
    const compNova = createCompetitor(db, userA, 'NovaX'); createdCompetitors.push(compNova);

    const d1 = deals.createDeal(userA, { deal_name: 'BigCo Renewal', outcome: 'won', deal_value_usd: 30000 });
    const d2 = deals.createDeal(userA, { deal_name: 'MidCo', outcome: 'lost', competitor_id: compAcme, deal_value_usd: 40000 });
    const d3 = deals.createDeal(userA, { deal_name: 'SmallCo', outcome: 'lost', competitor_id: compNova, deal_value_usd: 15000 });
    const listed = deals.listDeals(userA);
    check('3 deals saved & listed', listed.total === 3, `total=${listed.total}`);
    check('won deal has no competitor', d1.competitor_id === null);
    check('lost deal tied to competitor', d2.competitor_id === compAcme);

    const edited = deals.updateDeal(userA, d2.id, { deal_value_usd: 45000, notes: 'reopened' });
    check('deal edit persisted', edited.deal_value_usd === 45000 && edited.notes === 'reopened');
    deals.deleteDeal(userA, d3.id);
    check('deal delete works', deals.listDeals(userA).total === 2);
    // Reject lost deal without competitor.
    let rejected = false;
    try { deals.createDeal(userA, { deal_name: 'NoComp', outcome: 'lost' }); } catch (e) { rejected = e.status === 400; }
    check('lost deal without competitor rejected', rejected);
    report.tests.test1 = { saved: 3, after_delete: deals.listDeals(userA).total };

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 2: Slack slash command parser ──');
    const cmds = [
      '/foresight lost-deal Acme $40K vs BambooHR',
      '/foresight won-deal ContosoCorp $25K',
      '/foresight stalled Beta-Q4 $15K vs Workday',
      'won-deal Contoso',
    ];
    const parsedAll = [];
    for (const c of cmds) {
      const text = c.replace(/^\/foresight\s+/, '');
      const p = slack.parseSlackCommand(text);
      parsedAll.push({ input: c, parsed: p });
      console.log(`    "${c}"\n      -> ${JSON.stringify({ outcome: p.outcome, deal_name: p.deal_name, value_usd: p.value_usd, competitor_name: p.competitor_name })}`);
    }
    check('parse #1 lost Acme $40K vs BambooHR',
      parsedAll[0].parsed.outcome === 'lost' && parsedAll[0].parsed.deal_name === 'Acme' &&
      parsedAll[0].parsed.value_usd === 40000 && parsedAll[0].parsed.competitor_name === 'BambooHR');
    check('parse #2 won ContosoCorp $25K',
      parsedAll[1].parsed.outcome === 'won' && parsedAll[1].parsed.deal_name === 'ContosoCorp' &&
      parsedAll[1].parsed.value_usd === 25000 && parsedAll[1].parsed.competitor_name === null);
    check('parse #3 stalled Beta-Q4 $15K vs Workday',
      parsedAll[2].parsed.outcome === 'stalled' && parsedAll[2].parsed.deal_name === 'Beta-Q4' &&
      parsedAll[2].parsed.value_usd === 15000 && parsedAll[2].parsed.competitor_name === 'Workday');
    check('parse #4 won Contoso (no value)',
      parsedAll[3].parsed.outcome === 'won' && parsedAll[3].parsed.deal_name === 'Contoso' && parsedAll[3].parsed.value_usd === null);
    check('value parser handles variants',
      slack.parseDealValue('$40K') === 40000 && slack.parseDealValue('40000') === 40000 &&
      slack.parseDealValue('1.5M') === 1500000 && slack.parseDealValue('$40,000') === 40000);
    report.tests.test2 = parsedAll.map(x => ({ input: x.input, parsed: { outcome: x.parsed.outcome, deal_name: x.parsed.deal_name, value_usd: x.parsed.value_usd, competitor_name: x.parsed.competitor_name } }));

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 3: Slack signing verification (live endpoint) ──');
    const body = 'team_id=T_TEST&user_id=U_TEST&command=%2Fforesight&text=won-deal+SmokeTest';
    // Valid signature
    const validHeaders = slack.signSlackRequest(SIGNING_SECRET, body);
    const okRes = await httpPost('/api/slack/commands', body, validHeaders);
    check('valid signature is NOT 401', okRes.status !== 401, `status=${okRes.status}`);
    // Forged signature
    const forged = { ...validHeaders, 'x-slack-signature': 'v0=' + 'deadbeef'.repeat(8) };
    const forgedRes = await httpPost('/api/slack/commands', body, forged);
    check('forged signature rejected with 401', forgedRes.status === 401, `status=${forgedRes.status}`);
    // Unsigned
    const unsignedRes = await httpPost('/api/slack/commands', body, {});
    check('unsigned request rejected with 401', unsignedRes.status === 401, `status=${unsignedRes.status}`);
    // Stale timestamp (replay) — sign with a 10-min-old timestamp
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const staleHeaders = slack.signSlackRequest(SIGNING_SECRET, body, oldTs);
    const staleRes = await httpPost('/api/slack/commands', body, staleHeaders);
    check('stale timestamp (replay) rejected with 401', staleRes.status === 401, `status=${staleRes.status}`);
    // Unit-level positive/negative
    const ts = Math.floor(Date.now() / 1000);
    const sig = slack.signSlackRequest(SIGNING_SECRET, body, ts)['x-slack-signature'];
    check('verify fn accepts good sig', slack.verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: String(ts), signature: sig, rawBody: body }).ok);
    check('verify fn rejects tampered body', !slack.verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: String(ts), signature: sig, rawBody: body + 'x' }).ok);
    report.tests.test3 = { valid_status: okRes.status, forged_status: forgedRes.status, unsigned_status: unsignedRes.status, stale_status: staleRes.status };

    // Bonus: full Slack command -> deal (handler logic, in-process)
    console.log('\n── Test 2b: Slack command end-to-end (parse -> create deal) ──');
    const userS = createUser(db, 'Phase9 Slack'); createdUsers.push(userS);
    const bamboo = createCompetitor(db, userS, 'BambooHR'); createdCompetitors.push(bamboo);
    const sp = slack.parseSlackCommand('lost-deal Acme $40K vs BambooHR');
    const comps = db.prepare('SELECT id, name FROM competitors WHERE user_id = ?').all(userS);
    const match = slack.findCompetitorMatch(comps, sp.competitor_name);
    const slackDeal = deals.createDeal(userS, { deal_name: sp.deal_name, outcome: sp.outcome, competitor_id: match.id, deal_value_usd: sp.value_usd, source: 'slack_command' });
    check('Slack command logged a deal vs matched competitor', slackDeal.competitor_id === bamboo && slackDeal.source === 'slack_command' && slackDeal.deal_value_usd === 40000);

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 4: Correlation engine — 20 deals, 12 lost vs X, 8 in pricing windows ──');
    const userB = createUser(db, 'Phase9 B'); createdUsers.push(userB);
    const compX = createCompetitor(db, userB, 'CompetitorX'); createdCompetitors.push(compX);
    insertPricingChange(db, compX, 35); // one pricing change 35 days ago

    // 8 losses inside the 30-day-before-close window of the pricing change.
    const inWindowDays = [6, 10, 14, 18, 22, 26, 29, 30];
    inWindowDays.forEach((d, i) => deals.createDeal(userB, { deal_name: `InWin ${i + 1}`, outcome: 'lost', competitor_id: compX, deal_value_usd: 20000 + i * 5000, close_date: dayStr(d) }));
    // 4 losses far away (no pricing change in their window).
    [120, 130, 140, 150].forEach((d, i) => deals.createDeal(userB, { deal_name: `Far ${i + 1}`, outcome: 'lost', competitor_id: compX, deal_value_usd: 30000, close_date: dayStr(d) }));
    // 8 wins to reach 20 total.
    for (let i = 0; i < 8; i++) deals.createDeal(userB, { deal_name: `Win ${i + 1}`, outcome: 'won', deal_value_usd: 25000, close_date: dayStr(i + 1) });

    const roi = engine.getRoiDashboard(userB);
    const pricingPattern = roi.patterns.find(p => p.pattern_type === 'pricing_change_correlated_with_losses');
    check('20 deals logged', roi.total_deals === 20, `total=${roi.total_deals}`);
    check('pricing pattern detected', !!pricingPattern);
    check('pricing pattern supported by 8 deals', pricingPattern && pricingPattern.supporting_deal_ids.length === 8, `count=${pricingPattern?.supporting_deal_ids.length}`);
    check('confidence is medium (6-14 deals)', pricingPattern && pricingPattern.confidence === 'medium', `conf=${pricingPattern?.confidence}`);
    check('description uses "correlate", not "caused"', pricingPattern && /correlate/i.test(pricingPattern.pattern_description) && !/caused/i.test(pricingPattern.pattern_description.replace(/does not prove it caused/i, '')));
    console.log(`    pattern: ${pricingPattern?.pattern_description}`);
    report.tests.test4 = { total_deals: roi.total_deals, pricing_supporting: pricingPattern?.supporting_deal_ids.length, confidence: pricingPattern?.confidence, revenue_at_risk: roi.revenue_at_risk_usd, description: pricingPattern?.pattern_description };

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 5: Empty state (0 deals) ──');
    const userEmpty = createUser(db, 'Phase9 Empty'); createdUsers.push(userEmpty);
    const roiEmpty = engine.getRoiDashboard(userEmpty);
    check('status is empty', roiEmpty.status === 'empty', `status=${roiEmpty.status}`);
    check('no patterns', roiEmpty.patterns.length === 0);
    report.tests.test5 = { status: roiEmpty.status, patterns: roiEmpty.patterns.length };

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 6: Below-threshold (3 deals) shows no fake patterns ──');
    const userLow = createUser(db, 'Phase9 Low'); createdUsers.push(userLow);
    const compLow = createCompetitor(db, userLow, 'LowComp'); createdCompetitors.push(compLow);
    insertPricingChange(db, compLow, 10);
    deals.createDeal(userLow, { deal_name: 'L1', outcome: 'lost', competitor_id: compLow, deal_value_usd: 10000, close_date: dayStr(2) });
    deals.createDeal(userLow, { deal_name: 'L2', outcome: 'lost', competitor_id: compLow, deal_value_usd: 12000, close_date: dayStr(4) });
    deals.createDeal(userLow, { deal_name: 'W1', outcome: 'won', deal_value_usd: 9000, close_date: dayStr(1) });
    const roiLow = engine.getRoiDashboard(userLow);
    check('status is insufficient', roiLow.status === 'insufficient', `status=${roiLow.status}`);
    check('engine produced no patterns below threshold', roiLow.patterns.length === 0, `patterns=${roiLow.patterns.length}`);
    check('no rows persisted to correlations', db.prepare('SELECT COUNT(*) AS n FROM correlations WHERE user_id = ?').get(userLow).n === 0);
    report.tests.test6 = { status: roiLow.status, patterns: roiLow.patterns.length };

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── Test 7: Privacy — user A never sees user B deals ──');
    const aDeals = deals.listDeals(userA).deals;
    check('A list contains only A deals', aDeals.every(d => d.user_id === userA), `${aDeals.length} rows`);
    // A tries to read one of B's deals by id
    const bDeal = db.prepare('SELECT id FROM deals WHERE user_id = ?').get(userB);
    check('A cannot fetch B deal by id', deals.getDeal(userA, bDeal.id) === null);
    // A cannot update/delete B's deal
    let updateBlocked = false, deleteBlocked = false;
    try { deals.updateDeal(userA, bDeal.id, { deal_name: 'hack' }); } catch (e) { updateBlocked = e.status === 404; }
    try { deals.deleteDeal(userA, bDeal.id); } catch (e) { deleteBlocked = e.status === 404; }
    check('A cannot update B deal', updateBlocked);
    check('A cannot delete B deal', deleteBlocked);
    // A's ROI never references B's deals
    const aRoiDealIds = new Set();
    engine.getRoiDashboard(userA).patterns.forEach(p => p.supporting_deal_ids.forEach(id => aRoiDealIds.add(id)));
    const bDealIds = db.prepare('SELECT id FROM deals WHERE user_id = ?').all(userB).map(r => r.id);
    check('A ROI excludes all B deal ids', bDealIds.every(id => !aRoiDealIds.has(id)));
    report.tests.test7 = { a_deal_count: aDeals.length, cross_read_null: deals.getDeal(userA, bDeal.id) === null };

  } finally {
    // ── Cleanup all test rows ──
    console.log('\n── Cleanup ──');
    const compList = createdCompetitors;
    for (const uid of createdUsers) {
      db.prepare('DELETE FROM deals WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM correlations WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM pattern_alerts WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM slack_installations WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM settings WHERE user_id = ?').run(uid);
    }
    for (const cid of compList) {
      db.prepare('DELETE FROM changes WHERE competitor_id = ?').run(cid);
      db.prepare('DELETE FROM competitors WHERE id = ?').run(cid);
    }
    for (const uid of createdUsers) db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    console.log(`  removed ${createdUsers.length} test users, ${compList.length} competitors, and their deals/changes`);
  }

  report.summary = { pass, fail };
  fs.writeFileSync(path.join(__dirname, 'phase9-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n══════════ Phase 9: ${pass} passed, ${fail} failed ══════════`);
  console.log('Report written to phase9-report.json');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
