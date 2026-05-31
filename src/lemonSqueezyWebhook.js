// Phase 10 — Lemon Squeezy webhook handler.
//
// Security & correctness contract (see docs/webhook-event-mapping.md):
//   1. Signature is verified against the RAW body with timing-safe HMAC-SHA256
//      BEFORE the body is parsed. Missing/invalid → 401 + audit, never processed.
//   2. Idempotent: the verified signature doubles as the delivery fingerprint
//      (Lemon Squeezy does not include a stable event id in the body; an
//      identical retry produces an identical body and therefore an identical
//      signature). It is stored in payment_events.lemon_squeezy_event_id, which
//      is UNIQUE — the DB is the final idempotency backstop.
//   3. Subscription state is driven SOLELY by these webhooks. The billing routes
//      never write tier/status directly.
//   4. Returns 200 for any structurally valid event (including ones we no-op
//      on) so Lemon Squeezy does not retry them. Returns 500 ONLY on a genuine
//      processing/DB error, so LS retries (it backs off up to ~3 days).

const { getDb } = require('./db');
const { logAudit } = require('./lib/audit');
const ls = require('./lemonSqueezy');

// Lemon Squeezy subscription.status → our constrained subscription_status set.
function mapStatus(lsStatus) {
  switch (lsStatus) {
    case 'active':
    case 'on_trial':   return 'active';
    case 'paused':     return 'paused';
    case 'past_due':   return 'past_due';
    case 'unpaid':     return 'past_due';
    case 'cancelled':  return 'cancelled';
    case 'expired':    return 'expired';
    default:           return 'active';
  }
}

// SQLite-friendly timestamp ("YYYY-MM-DD HH:MM:SS") from an ISO string.
function toTs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
}

function maskSig(sig) {
  if (!sig || typeof sig !== 'string') return '(none)';
  return sig.length <= 8 ? '****' : `${sig.slice(0, 4)}…${sig.slice(-4)}`;
}

function findWorkspaceBySubscription(subscriptionId) {
  if (!subscriptionId) return null;
  return getDb().prepare('SELECT * FROM workspaces WHERE subscription_id = ?').get(String(subscriptionId)) || null;
}

// Main entry. Returns { statusCode, body }. `req` is used only for audit IP/UA.
function handleLemonSqueezyWebhook(rawBody, signature, req) {
  const db = getDb();

  // ── 1. Signature verification (timing-safe, raw body) ──────────────────────
  if (!ls.verifyWebhookSignature(rawBody, signature)) {
    logAudit({
      eventType: 'webhook_signature_invalid',
      eventData: { provided: maskSig(signature), reason: signature ? 'mismatch' : 'missing' },
      req,
    });
    return { statusCode: 401, body: { error: 'invalid signature' } };
  }

  // ── 2. Parse (only after verification) ─────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch (_) {
    return { statusCode: 200, body: { received: true, note: 'unparseable body, acknowledged' } };
  }

  const eventName = payload?.meta?.event_name;
  const customData = payload?.meta?.custom_data || {};
  const resource = payload?.data || {};
  const attrs = resource.attributes || {};
  const subscriptionId = resource.id ? String(resource.id) : null;
  if (!eventName) {
    return { statusCode: 200, body: { received: true, note: 'no event_name, acknowledged' } };
  }

  // Idempotency key = the verified signature (stable across LS retries).
  const eventKey = String(signature).trim();

  // ── 3. Idempotency: have we already processed this delivery? ───────────────
  const seen = db.prepare('SELECT id, status FROM payment_events WHERE lemon_squeezy_event_id = ?').get(eventKey);
  if (seen) {
    return { statusCode: 200, body: { received: true, duplicate: true } };
  }

  // Record receipt first (status='received'). UNIQUE(lemon_squeezy_event_id) is
  // the backstop against a concurrent duplicate slipping past the check above.
  let eventRowId;
  try {
    const r = db.prepare(`
      INSERT INTO payment_events (workspace_id, lemon_squeezy_event_id, event_type, payload, received_at, status)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'received')
    `).run(null, eventKey, String(eventName), JSON.stringify(payload));
    eventRowId = r.lastInsertRowid;
  } catch (e) {
    // UNIQUE violation → another delivery beat us to it. Treat as duplicate.
    return { statusCode: 200, body: { received: true, duplicate: true } };
  }

  // ── 4. Process ─────────────────────────────────────────────────────────────
  try {
    const result = processEvent({ db, eventName, customData, attrs, subscriptionId, req });

    db.prepare("UPDATE payment_events SET status = 'processed', processed_at = CURRENT_TIMESTAMP, workspace_id = ? WHERE id = ?")
      .run(result.workspaceId ?? null, eventRowId);

    return { statusCode: 200, body: { received: true, event: eventName, ...(result.note ? { note: result.note } : {}) } };
  } catch (e) {
    db.prepare("UPDATE payment_events SET status = 'failed', error = ? WHERE id = ?")
      .run(String(e.message || e).slice(0, 500), eventRowId);
    // Genuine processing error → 500 so Lemon Squeezy retries.
    return { statusCode: 500, body: { error: 'processing failed' } };
  }
}

// Returns { workspaceId, note? }. Throws only on genuine (retryable) errors.
function processEvent({ db, eventName, customData, attrs, subscriptionId, req }) {
  const periodEnd = toTs(attrs.cancelled ? attrs.ends_at : attrs.renews_at) || toTs(attrs.renews_at) || toTs(attrs.ends_at);

  switch (eventName) {
    // a. New subscription — link to the workspace via checkout custom_data.
    case 'subscription_created': {
      const wsId = customData.workspace_id ? Number(customData.workspace_id) : null;
      if (!wsId) return { workspaceId: null, note: 'no workspace_id in custom_data, acknowledged' };
      const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(wsId);
      if (!ws) return { workspaceId: null, note: `workspace ${wsId} not found, acknowledged` };

      const tier = ls.variantToTier(attrs.variant_id) || 'pro';
      db.prepare(`
        UPDATE workspaces SET
          subscription_id = ?, subscription_status = 'active', subscription_tier = ?,
          subscription_current_period_end = ?, subscription_cancel_at_period_end = 0,
          lemon_squeezy_customer_id = ?, lemon_squeezy_subscription_variant_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(subscriptionId, tier, periodEnd, attrs.customer_id != null ? String(attrs.customer_id) : null,
             attrs.variant_id != null ? String(attrs.variant_id) : null, wsId);
      logAudit({ workspaceId: wsId, eventType: 'subscription_created', eventData: { subscriptionId, tier }, req });
      return { workspaceId: wsId };
    }

    // b. Generic update — re-sync status / period / variant / cancel flag.
    case 'subscription_updated': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      const tier = ls.variantToTier(attrs.variant_id) || ws.subscription_tier;
      db.prepare(`
        UPDATE workspaces SET
          subscription_status = ?, subscription_tier = ?,
          subscription_current_period_end = ?,
          subscription_cancel_at_period_end = ?,
          lemon_squeezy_subscription_variant_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(mapStatus(attrs.status), tier, periodEnd, attrs.cancelled ? 1 : 0,
             attrs.variant_id != null ? String(attrs.variant_id) : ws.lemon_squeezy_subscription_variant_id, ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_updated', eventData: { status: attrs.status }, req });
      return { workspaceId: ws.id };
    }

    // c. Scheduled to cancel at period end (LS keeps access until ends_at).
    case 'subscription_cancelled': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare(`
        UPDATE workspaces SET
          subscription_status = 'cancelled', subscription_cancel_at_period_end = 1,
          subscription_current_period_end = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(toTs(attrs.ends_at) || periodEnd, ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_cancelled', eventData: { endsAt: attrs.ends_at }, req });
      return { workspaceId: ws.id };
    }

    // d. Cancellation undone.
    case 'subscription_resumed': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare(`
        UPDATE workspaces SET
          subscription_status = 'active', subscription_cancel_at_period_end = 0,
          subscription_current_period_end = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(periodEnd || ws.subscription_current_period_end, ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_resumed', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // e. Fully expired — downgrade to free and unlink the subscription.
    case 'subscription_expired': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare(`
        UPDATE workspaces SET
          subscription_tier = 'free', subscription_status = 'expired',
          subscription_id = NULL, subscription_cancel_at_period_end = 0,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_expired', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // f. Paused — keep tier visible, mark paused (read-only enforced at UI).
    case 'subscription_paused': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare("UPDATE workspaces SET subscription_status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_paused', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // g. Unpaused.
    case 'subscription_unpaused': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare("UPDATE workspaces SET subscription_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_unpaused', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // h. Payment succeeded — audit; refresh period end; recover from past_due.
    case 'subscription_payment_success': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare(`
        UPDATE workspaces SET
          subscription_status = CASE WHEN subscription_status = 'past_due' THEN 'active' ELSE subscription_status END,
          subscription_current_period_end = COALESCE(?, subscription_current_period_end),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(periodEnd, ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_payment_succeeded', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // i. Payment failed — mark past_due (LS dunning retries; don't downgrade).
    case 'subscription_payment_failed': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare("UPDATE workspaces SET subscription_status = 'past_due', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_payment_failed', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // j. Payment recovered after a failure.
    case 'subscription_payment_recovered': {
      const ws = findWorkspaceBySubscription(subscriptionId);
      if (!ws) return { workspaceId: null, note: 'unknown subscription, acknowledged' };
      db.prepare("UPDATE workspaces SET subscription_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ws.id);
      logAudit({ workspaceId: ws.id, eventType: 'subscription_payment_recovered', eventData: {}, req });
      return { workspaceId: ws.id };
    }

    // Any other (order_created, license_*, etc.) — acknowledged, no-op.
    default:
      return { workspaceId: null, note: `no-op for ${eventName}` };
  }
}

module.exports = { handleLemonSqueezyWebhook, mapStatus, toTs };
