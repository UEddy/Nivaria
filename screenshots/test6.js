// Test 6 — waitlist submissions (public endpoint). Team w/ size, Business w/
// use_case, duplicate handling, and the 5/IP/hour rate limit.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const j = (r) => r.json().catch(() => ({}));
const post = (data) => fetch(`${BASE}/api/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
function readDb(sql) {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec(sql);
    return r[0] ? r[0].values.map(v => Object.fromEntries(v.map((x, i) => [r[0].columns[i], x]))) : [];
  });
}

(async () => {
  const checks = [];
  const TEAM = `team-lead-${Date.now()}@acme.test`;
  const BIZ = `biz-${Date.now()}@acme.test`;

  // 1. Team + team_size_estimate=15
  const t = await j(await post({ email: TEAM, tier: 'team', teamSizeEstimate: 15 }));
  console.log('team submit →', JSON.stringify(t));
  const trow = (await readDb(`SELECT tier, team_size_estimate, use_case FROM waitlist_signups WHERE email='${TEAM}'`))[0];
  console.log('  DB row:', JSON.stringify(trow));
  checks.push(t.success && t.alreadySignedUp === false && trow && trow.tier === 'team' && trow.team_size_estimate === 15);

  // 2. Business + use_case
  const UC = 'We are a B2B SaaS in fintech tracking 12 competitors';
  const b = await j(await post({ email: BIZ, tier: 'business', useCase: UC }));
  console.log('business submit →', JSON.stringify(b));
  const brow = (await readDb(`SELECT tier, team_size_estimate, use_case FROM waitlist_signups WHERE email='${BIZ}'`))[0];
  console.log('  DB row:', JSON.stringify(brow));
  checks.push(b.success && b.alreadySignedUp === false && brow && brow.tier === 'business' && brow.use_case === UC);

  // 3. Duplicate (same email + tier) → graceful
  const dup = await j(await post({ email: TEAM, tier: 'team' }));
  console.log('duplicate team submit →', JSON.stringify(dup), dup.alreadySignedUp ? '✅ graceful' : '❌');
  checks.push(dup.success === true && dup.alreadySignedUp === true);

  // 4. Rate limit (5/IP/hour). We've sent 3 so far; keep going until 429.
  let got429 = false, total = 3;
  for (let i = 0; i < 8; i++) {
    const r = await post({ email: `rl-${Date.now()}-${i}@acme.test`, tier: 'team' });
    total++;
    if (r.status === 429) { got429 = true; console.log(`rate limit hit (429) after ${total} total submissions ✅`); break; }
  }
  if (!got429) console.log('❌ never hit 429');
  checks.push(got429);

  console.log(`\nTEST 6: ${checks.every(Boolean) ? 'PASS ✅' : 'FAIL ❌ ' + JSON.stringify(checks)}`);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
