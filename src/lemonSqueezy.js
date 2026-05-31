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
};
