// Test 1 failure diagnosis (read-only / external queries only).
require('dotenv').config();
const BASE = 'http://localhost:3000';

(async () => {
  // 1. ngrok tunnels — what public URL is live right now?
  console.log('═══ ngrok tunnels ═══');
  let publicUrl = null;
  try {
    const t = await (await fetch('http://127.0.0.1:4040/api/tunnels')).json();
    (t.tunnels || []).forEach(tn => { console.log(`  ${tn.public_url} → ${tn.config?.addr}`); if (/^https/.test(tn.public_url)) publicUrl = tn.public_url; });
    if (!t.tunnels?.length) console.log('  (no active tunnels)');
  } catch (e) { console.log('  ngrok API error:', e.message); }

  // 2. ALL recent ngrok requests (not just webhook) — is ANY traffic flowing?
  console.log('\n═══ recent ngrok requests (last 15) ═══');
  try {
    const j = await (await fetch('http://127.0.0.1:4040/api/requests/http?limit=15')).json();
    console.log(`  total in buffer: ${(j.requests || []).length}`);
    (j.requests || []).slice(0, 15).forEach(r => console.log(`  ${r.request?.method} ${r.request?.uri} → ${r.response?.status_code}`));
  } catch (e) { console.log('  error:', e.message); }

  // 3. Does the public webhook URL actually route to our server? (expect 401)
  console.log('\n═══ public webhook URL reachability ═══');
  if (publicUrl) {
    try {
      const r = await fetch(`${publicUrl}/api/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      console.log(`  POST ${publicUrl}/api/webhooks/lemonsqueezy → ${r.status} (401 = routes to our server, signature rejected ✅)`);
    } catch (e) { console.log('  error:', e.message); }
  } else { console.log('  no public URL discovered'); }

  // 4. Did Lemon Squeezy actually create the subscription? (authoritative)
  console.log('\n═══ Lemon Squeezy: recent subscriptions for this store ═══');
  try {
    const { lemonSqueezySetup, listSubscriptions } = require('@lemonsqueezy/lemonsqueezy.js');
    lemonSqueezySetup({ apiKey: process.env.LEMONSQUEEZY_API_KEY });
    const { data, error } = await listSubscriptions({ filter: { storeId: process.env.LEMONSQUEEZY_STORE_ID } });
    if (error) { console.log('  LS API error:', error.message); }
    else {
      const subs = data?.data || [];
      console.log(`  subscriptions in store: ${subs.length}`);
      subs.slice(0, 5).forEach(s => {
        const a = s.attributes || {};
        console.log(`    id=${s.id} status=${a.status} variant=${a.variant_id} test_mode=${a.test_mode} created=${a.created_at} email=${a.user_email}`);
      });
    }
  } catch (e) { console.log('  error:', e.message); }

  // 5. Are the webhook env vars present on the server side?
  console.log('\n═══ server env (presence only) ═══');
  console.log(`  LEMONSQUEEZY_API_KEY: ${process.env.LEMONSQUEEZY_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  LEMONSQUEEZY_STORE_ID: ${process.env.LEMONSQUEEZY_STORE_ID || 'MISSING'}`);
  console.log(`  LEMONSQUEEZY_PRO_VARIANT_ID: ${process.env.LEMONSQUEEZY_PRO_VARIANT_ID || 'MISSING'}`);
  console.log(`  LEMONSQUEEZY_WEBHOOK_SECRET: ${process.env.LEMONSQUEEZY_WEBHOOK_SECRET ? 'set (len ' + process.env.LEMONSQUEEZY_WEBHOOK_SECRET.length + ')' : 'MISSING'}`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
