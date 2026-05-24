// Task 3 verification — 20 fresh generations across multiple changes,
// counting em-dashes, en-dashes, and plus-sign prose connectors in
// persisted output. Also regenerates change #11 specifically so we can
// show before/after the prompt restructure.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:3000';

async function loadApiKey(userId) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(path.join(__dirname, 'data', 'competitor-shadow.db'));
  const sql = new SQL.Database(buf);
  const r = sql.exec(`SELECT api_key FROM users WHERE id = ${userId}`);
  return r[0]?.values?.[0]?.[0];
}

function makeReq(apiKey) {
  return (method, urlPath, body) => new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let payload = chunks;
        try { payload = JSON.parse(chunks); } catch (_) {}
        if (res.statusCode >= 400) return reject(Object.assign(new Error(payload?.error || `HTTP ${res.statusCode}`), { status: res.statusCode }));
        resolve(payload);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const DASH_RE = /[—–]/g;
// Plus sign as prose connector: letter+space-plus-space+letter, excluding numeric/tech contexts
function detectPlusConnectors(text) {
  if (!text) return [];
  const hits = [];
  const re = /\s\+\s/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const i = m.index;
    const before = text[i - 1];
    const after  = text[i + m[0].length];
    if (before && /[a-zA-Z]/.test(before) && after && /[a-zA-Z]/.test(after)) {
      const start = Math.max(0, i - 25);
      const end   = Math.min(text.length, i + m[0].length + 25);
      hits.push(text.slice(start, end).trim());
    }
  }
  return hits;
}

function audit(playbooks, label) {
  let totalDashes = 0;
  let totalPlus = 0;
  const violations = [];
  for (const p of playbooks) {
    const blob = (p.subject_line || '') + '\n' + (p.body || '');
    const d = (blob.match(DASH_RE) || []).length;
    const pluses = detectPlusConnectors(blob);
    totalDashes += d;
    totalPlus   += pluses.length;
    if (d > 0 || pluses.length > 0) {
      violations.push({ change_id: p.change_id, message_type: p.message_type, dashes: d, plus: pluses });
    }
  }
  return { label, count: playbooks.length, totalDashes, totalPlus, violations };
}

(async () => {
  const eddyKey = await loadApiKey(2);
  const demoKey = await loadApiKey(1);
  if (!eddyKey || !demoKey) { console.error('Could not load API keys'); process.exit(1); }
  const eddyReq = makeReq(eddyKey);
  const demoReq = makeReq(demoKey);

  // Step 1 — regenerate change #11 (eddy's seed), capture AFTER
  console.log('── Regenerating change #11 with hardened prompt ─────────────────');
  await eddyReq('POST', '/api/playbooks/changes/11/generate');
  const after11 = (await eddyReq('GET', '/api/playbooks/changes/11')).playbooks;
  fs.writeFileSync(path.join(__dirname, 'change11-after.json'), JSON.stringify(after11, null, 2));
  console.log(`  Saved ${after11.length} variants for change#11. Audit:`);
  const auditChange11 = audit(after11, 'change#11 AFTER (3 fresh generations)');
  console.log(`    dashes=${auditChange11.totalDashes}, plus_connectors=${auditChange11.totalPlus}, status=${after11.map(p=>p.generation_status).join('|')}`);

  // Track the 3 generations from change #11 in the running total
  let total20Dashes = auditChange11.totalDashes;
  let total20Plus   = auditChange11.totalPlus;
  let totalGenerations = after11.length;          // 3
  const allViolations = auditChange11.violations.slice();
  const allSamples = after11.map(p => ({ change_id: 11, message_type: p.message_type, subject: p.subject_line, body: p.body }));

  // Step 2 — generate on demo changes #1 (Acme) and #2 (NovaTech), one cycle each = 6
  for (const cid of [1, 2]) {
    console.log(`── Generating on demo change #${cid} ──────────────────────────`);
    await demoReq('POST', `/api/playbooks/changes/${cid}/generate`);
    const pbs = (await demoReq('GET', `/api/playbooks/changes/${cid}`)).playbooks;
    const a = audit(pbs, `change#${cid} fresh`);
    console.log(`  ${pbs.length} variants. dashes=${a.totalDashes} plus=${a.totalPlus} statuses=${pbs.map(p=>p.generation_status).join('|')}`);
    total20Dashes += a.totalDashes;
    total20Plus   += a.totalPlus;
    totalGenerations += pbs.length;
    allViolations.push(...a.violations);
    for (const p of pbs) allSamples.push({ change_id: cid, message_type: p.message_type, subject: p.subject_line, body: p.body });
  }

  // Step 3 — additional regenerations to reach 20 total. Currently have 3+3+3=9. Need 11 more.
  // Do 4 more cycles on change #11 = 12 more generations. Plus we already have 9 = 21.
  // Adjust: do 4 cycles on #11 = 12 more, total = 9+12 = 21. Trim by stopping at 20.
  // Cleaner plan: 3 regen cycles on #11 (9 more) + 1 single-variant regen on demo #1 slack = total 9 + 9 + 1 = 19.
  // Even cleaner: do single-variant regenerations on the existing playbooks to count exactly.
  // Each single regen is 1 generation. Need 11 more (after 9 done) to hit 20.
  console.log('── 11 single-variant regenerations to reach 20 total ───────────');
  const targets = [
    ...after11.map(p => ({ key: eddyKey, id: p.id, change: 11, type: p.message_type })),
    // and demo changes:
  ];
  // Round-robin regenerate from the eddy + demo pool. Get current playbook ids for demo changes.
  const demo1Pbs = (await demoReq('GET', '/api/playbooks/changes/1')).playbooks;
  const demo2Pbs = (await demoReq('GET', '/api/playbooks/changes/2')).playbooks;
  for (const p of demo1Pbs) targets.push({ key: demoKey, id: p.id, change: 1, type: p.message_type });
  for (const p of demo2Pbs) targets.push({ key: demoKey, id: p.id, change: 2, type: p.message_type });

  let regenIdx = 0;
  for (let i = 0; i < 11; i++) {
    const t = targets[regenIdx % targets.length];
    regenIdx++;
    const r = makeReq(t.key);
    try {
      const out = await r('POST', `/api/playbooks/${t.id}/regenerate`);
      const pb = out.playbook;
      const blob = (pb.subject_line || '') + '\n' + (pb.body || '');
      const d = (blob.match(DASH_RE) || []).length;
      const pluses = detectPlusConnectors(blob);
      total20Dashes += d;
      total20Plus   += pluses.length;
      totalGenerations++;
      if (d > 0 || pluses.length > 0) allViolations.push({ change_id: t.change, message_type: t.type, dashes: d, plus: pluses });
      allSamples.push({ change_id: t.change, message_type: t.type, subject: pb.subject_line, body: pb.body });
      console.log(`  [${i+1}/11] regen change#${t.change} ${t.type}: dashes=${d} plus=${pluses.length}`);
    } catch (e) {
      console.error(`  [${i+1}/11] regen failed: ${e.message}`);
    }
  }

  const report = {
    generations: totalGenerations,
    total_em_or_en_dashes: total20Dashes,
    total_plus_connectors: total20Plus,
    violations: allViolations,
    samples_count: allSamples.length,
  };
  fs.writeFileSync(path.join(__dirname, 'task3-report.json'), JSON.stringify({ summary: report, change11_after: after11 }, null, 2));

  console.log('\n══════════ FINAL ══════════');
  console.log(`Total generations:           ${totalGenerations}`);
  console.log(`Em-dashes (—) in output:     ${total20Dashes}`);
  console.log(`En-dashes (–) in output:     ${total20Dashes > 0 ? '(included above)' : 0}  // counted together with em-dashes`);
  console.log(`Plus-as-prose-connector:     ${total20Plus}`);
  console.log(`Violations detail:           ${JSON.stringify(allViolations) || 'none'}`);
  console.log('\nReport written to task3-report.json');

  process.exit(total20Dashes === 0 && total20Plus === 0 ? 0 : 1);
})();
