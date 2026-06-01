// Test 3 (signature verification) + Test 4 (idempotency).
// Uses synthetic events with FAKE subscription/workspace ids so the real demo
// workspace state is never touched. Signs with the real webhook secret.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const send = (raw, sig) => fetch(`${BASE}/api/webhooks/lemonsqueezy`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-Event-Name': JSON.parse(raw).meta.event_name },
  body: raw,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

function dbCount(sql) {
  return require('sql.js')().then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'competitor-shadow.db')));
    const r = db.exec(sql);
    return r[0] ? Number(r[0].values[0][0]) : 0;
  });
}

(async () => {
  if (!SECRET) { console.error('no webhook secret'); process.exit(1); }

  // ── TEST 3: signature verification ──────────────────────────────────────────
  console.log('═══ TEST 3: webhook signature verification ═══');
  const p3 = JSON.stringify({ meta: { event_name: 'subscription_updated' }, data: { id: '9999990', attributes: { status: 'active', variant_id: 1728811 } } });
  const auditBefore = await dbCount("SELECT COUNT(*) FROM audit_log WHERE event_type='webhook_signature_invalid'");

  const bad = await send(p3, '0'.repeat(64));
  console.log(`  invalid signature → ${bad.status} ${JSON.stringify(bad.body)} (expect 401)`);

  const auditAfter = await dbCount("SELECT COUNT(*) FROM audit_log WHERE event_type='webhook_signature_invalid'");
  console.log(`  webhook_signature_invalid audit rows: ${auditBefore} → ${auditAfter} (expect +1)`);

  const good = await send(p3, sign(p3));
  console.log(`  valid signature   → ${good.status} ${JSON.stringify(good.body)} (expect 200)`);

  const t3 = bad.status === 401 && auditAfter === auditBefore + 1 && good.status === 200;
  console.log(`  TEST 3: ${t3 ? 'PASS ✅' : 'FAIL ❌'}`);

  // ── TEST 4: idempotency (same valid event twice) ────────────────────────────
  console.log('\n═══ TEST 4: idempotency ═══');
  // subscription_created for a NON-existent workspace → handler no-ops ("workspace
  // not found") but still records exactly one payment_events row. Re-sending the
  // identical body (same signature = same idempotency key) must be a duplicate.
  const p4 = JSON.stringify({ meta: { event_name: 'subscription_created', custom_data: { workspace_id: '999999' } }, data: { id: '9999991', attributes: { status: 'active', variant_id: 1728811, customer_id: 1, renews_at: '2026-07-01T00:00:00Z' } } });
  const sig4 = sign(p4);
  const rowsBefore = await dbCount(`SELECT COUNT(*) FROM payment_events WHERE lemon_squeezy_event_id='${sig4}'`);
  const first = await send(p4, sig4);
  const second = await send(p4, sig4);
  const rowsAfter = await dbCount(`SELECT COUNT(*) FROM payment_events WHERE lemon_squeezy_event_id='${sig4}'`);
  console.log(`  1st send → ${first.status} ${JSON.stringify(first.body)}`);
  console.log(`  2nd send → ${second.status} ${JSON.stringify(second.body)} (expect duplicate:true)`);
  console.log(`  payment_events rows for this event id: ${rowsBefore} → ${rowsAfter} (expect exactly 1)`);
  const t4 = first.status === 200 && second.status === 200 && second.body.duplicate === true && rowsAfter === 1;
  console.log(`  TEST 4: ${t4 ? 'PASS ✅' : 'FAIL ❌'}`);

  process.exit(t3 && t4 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
