// Phase 10 — Lemon Squeezy service wrapper.
//
// The API key lives ONLY in process.env. It is never returned to a client,
// never logged, never placed in an error message sent over the wire. This
// module is the single place the SDK is initialized.

const crypto = require('crypto');

let _configured = false;

// Lazily initialise the SDK exactly once. Throws if the API key is absent so
// callers surface a clear "billing not configured" error rather than a vague
// SDK failure.
function ensureConfigured() {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) throw new Error('LEMONSQUEEZY_API_KEY is not set');
  if (_configured) return;
  const { lemonSqueezySetup } = require('@lemonsqueezy/lemonsqueezy.js');
  lemonSqueezySetup({
    apiKey,
    // Never echo the key; log only the SDK's own (key-free) error message.
    onError: (err) => console.error('[lemonsqueezy] SDK error:', err && err.message ? err.message : 'unknown'),
  });
  _configured = true;
}

// Enough env present to attempt a checkout?
function isConfigured() {
  return !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID && process.env.LEMONSQUEEZY_PRO_VARIANT_ID);
}

// Default true; only the literal string 'false' turns test mode off (Phase 13).
function isTestMode() {
  return String(process.env.LEMONSQUEEZY_TEST_MODE == null ? 'true' : process.env.LEMONSQUEEZY_TEST_MODE).toLowerCase() !== 'false';
}

// Map a Lemon Squeezy variant id → our internal tier. Pro is the only active
// paid variant in Phase 10; unknown variants map to null (handled by caller).
function variantToTier(variantId) {
  if (variantId != null && String(variantId) === String(process.env.LEMONSQUEEZY_PRO_VARIANT_ID)) return 'pro';
  return null;
}

// Create an overlay checkout for a workspace. The workspace_id is attached as
// custom checkout data so the subscription_created webhook can link back.
async function createProCheckout({ workspaceId, userEmail }) {
  ensureConfigured();
  const { createCheckout } = require('@lemonsqueezy/lemonsqueezy.js');
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  const variantId = process.env.LEMONSQUEEZY_PRO_VARIANT_ID;
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  const { data, error } = await createCheckout(storeId, variantId, {
    checkoutData: {
      email: userEmail || undefined,
      custom: { workspace_id: String(workspaceId) }, // surfaces in webhook meta.custom_data
    },
    productOptions: {
      redirectUrl: `${appUrl}/app#/settings?upgraded=1`,
      receiptButtonText: 'Back to Foresight',
    },
    checkoutOptions: { embed: true, media: false, logo: true },
    testMode: isTestMode(),
  });
  if (error) throw new Error(error.message || 'Lemon Squeezy checkout failed');
  return data && data.data && data.data.attributes ? data.data.attributes.url : null;
}

// Reconcile support: find the workspace's subscription on Lemon Squeezy when a
// webhook was dropped/lost. Matches by customer id first, then owner email.
// Prefers an active subscription, then the most recently created.
async function findWorkspaceSubscription({ customerId, email }) {
  ensureConfigured();
  const { listSubscriptions } = require('@lemonsqueezy/lemonsqueezy.js');
  const { data, error } = await listSubscriptions({ filter: { storeId: process.env.LEMONSQUEEZY_STORE_ID } });
  if (error) throw new Error(error.message || 'Failed to list subscriptions');
  const subs = (data && data.data) || [];
  const matches = subs.filter((s) => {
    const a = s.attributes || {};
    return (customerId && String(a.customer_id) === String(customerId))
      || (email && a.user_email && String(a.user_email).toLowerCase() === String(email).toLowerCase());
  });
  if (!matches.length) return null;
  matches.sort((x, y) => {
    const ax = x.attributes || {}, ay = y.attributes || {};
    const rank = (s) => (s === 'active' ? 0 : s === 'past_due' || s === 'on_trial' ? 1 : 2);
    if (rank(ax.status) !== rank(ay.status)) return rank(ax.status) - rank(ay.status);
    return new Date(ay.created_at || 0) - new Date(ax.created_at || 0);
  });
  const best = matches[0];
  return { id: String(best.id), attributes: best.attributes || {} };
}

async function getSubscriptionState(subscriptionId) {
  ensureConfigured();
  const { getSubscription } = require('@lemonsqueezy/lemonsqueezy.js');
  const { data, error } = await getSubscription(subscriptionId);
  if (error) throw new Error(error.message || 'Failed to fetch subscription');
  return data && data.data ? data.data.attributes : null;
}

// Lemon Squeezy exposes the customer portal as a signed URL on the subscription
// resource (attributes.urls.customer_portal), so we fetch the sub and read it.
async function getCustomerPortalUrl(subscriptionId) {
  const attrs = await getSubscriptionState(subscriptionId);
  return attrs && attrs.urls ? attrs.urls.customer_portal : null;
}

// Schedule cancellation at period end (LS keeps access until then).
async function cancelAtPeriodEnd(subscriptionId) {
  ensureConfigured();
  const { cancelSubscription } = require('@lemonsqueezy/lemonsqueezy.js');
  const { error } = await cancelSubscription(subscriptionId);
  if (error) throw new Error(error.message || 'Failed to cancel subscription');
}

// Undo a scheduled cancellation.
async function resume(subscriptionId) {
  ensureConfigured();
  const { updateSubscription } = require('@lemonsqueezy/lemonsqueezy.js');
  const { error } = await updateSubscription(subscriptionId, { cancelled: false });
  if (error) throw new Error(error.message || 'Failed to resume subscription');
}

// Timing-safe HMAC-SHA256 verification of a RAW webhook body against the
// X-Signature header. Returns true ONLY on an equal-length, byte-equal match.
// Never uses === string comparison.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
    .digest('hex');
  const provided = signatureHeader.trim();

  // Reject length mismatch BEFORE timingSafeEqual (which throws on unequal len).
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (_) {
    return false;
  }
}

module.exports = {
  isConfigured, isTestMode, variantToTier,
  createProCheckout, getSubscriptionState, getCustomerPortalUrl,
  cancelAtPeriodEnd, resume, verifyWebhookSignature,
  findWorkspaceSubscription,
};
