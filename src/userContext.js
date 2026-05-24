// Phase 6 — per-user business context.
//
// One row per user, every field optional. Saved via Account Settings or the
// post-registration onboarding form, and injected into every AI analysis
// prompt so battle cards are framed from the user's strategic perspective
// instead of an outside-observer view.
//
// Security: every read and write is scoped by user_id. Free-text fields are
// length-capped (5000 chars per field) — they're already trusted user input
// for the AI prompt, but the cap bounds token cost and bounds any future UI
// rendering surfaces.

const { getDb } = require('./db');

const MAX_FIELD_CHARS = 5000;
const ALLOWED_DEAL_SIZES   = ['small', 'mid', 'large', 'enterprise'];
const ALLOWED_SALES_MOTIONS = ['plg', 'slg', 'hybrid'];

const FREE_TEXT_FIELDS = ['company_name', 'what_we_sell', 'target_icp', 'our_positioning'];

function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, MAX_FIELD_CHARS);
}

/**
 * Returns the user's context row, or null if none exists. Always scoped to
 * userId — never accept a row id from a route handler.
 */
function getUserContext(userId) {
  if (!Number.isInteger(userId)) throw new Error('getUserContext: userId required');
  const db = getDb();
  const row = db.prepare(`
    SELECT id, user_id, company_name, what_we_sell, target_icp, our_positioning,
           typical_deal_size, sales_motion, created_at, updated_at
    FROM user_context WHERE user_id = ?
  `).get(userId);
  return row || null;
}

/**
 * True when the user has provided at least one meaningful field. We do NOT
 * count an empty row as "having context" — the prompt would be polluted with
 * empty key/value pairs that confuse the model.
 */
function hasMeaningfulContext(ctx) {
  if (!ctx) return false;
  const hasFree = FREE_TEXT_FIELDS.some(f => ctx[f] && String(ctx[f]).trim().length > 0);
  const hasDeal = !!(ctx.typical_deal_size && ALLOWED_DEAL_SIZES.includes(ctx.typical_deal_size));
  const hasMot  = !!(ctx.sales_motion && ALLOWED_SALES_MOTIONS.includes(ctx.sales_motion));
  return hasFree || hasDeal || hasMot;
}

/**
 * Validate + upsert. Returns { ok: true, context } on success or
 * { ok: false, error: '...' } on validation failure. Caller decides how to
 * surface the error (route handler returns 400).
 */
function saveUserContext(userId, fields) {
  if (!Number.isInteger(userId)) throw new Error('saveUserContext: userId required');

  // Validate enums up-front so we return a clean 400 rather than relying on
  // the CHECK constraint to throw deep inside sql.js.
  const dealSize = fields.typical_deal_size === undefined ? undefined
                 : fields.typical_deal_size === null || fields.typical_deal_size === '' ? null
                 : String(fields.typical_deal_size).toLowerCase().trim();
  if (dealSize !== undefined && dealSize !== null && !ALLOWED_DEAL_SIZES.includes(dealSize)) {
    return { ok: false, error: `typical_deal_size must be one of: ${ALLOWED_DEAL_SIZES.join(', ')}` };
  }

  const motion = fields.sales_motion === undefined ? undefined
               : fields.sales_motion === null || fields.sales_motion === '' ? null
               : String(fields.sales_motion).toLowerCase().trim();
  if (motion !== undefined && motion !== null && !ALLOWED_SALES_MOTIONS.includes(motion)) {
    return { ok: false, error: `sales_motion must be one of: ${ALLOWED_SALES_MOTIONS.join(', ')}` };
  }

  // Length-cap free-text fields.
  for (const f of FREE_TEXT_FIELDS) {
    if (fields[f] !== undefined && fields[f] !== null && String(fields[f]).length > MAX_FIELD_CHARS) {
      return { ok: false, error: `${f} must be ${MAX_FIELD_CHARS} characters or fewer` };
    }
  }

  const db = getDb();
  const existing = getUserContext(userId);

  // Build the row by merging defaults from existing values with anything the
  // caller explicitly provided. Anything explicitly set to null/'' clears
  // that field; anything `undefined` leaves the existing value alone.
  const merged = {
    company_name:      fields.company_name      !== undefined ? clean(fields.company_name)      : (existing?.company_name      ?? null),
    what_we_sell:      fields.what_we_sell      !== undefined ? clean(fields.what_we_sell)      : (existing?.what_we_sell      ?? null),
    target_icp:        fields.target_icp        !== undefined ? clean(fields.target_icp)        : (existing?.target_icp        ?? null),
    our_positioning:   fields.our_positioning   !== undefined ? clean(fields.our_positioning)   : (existing?.our_positioning   ?? null),
    typical_deal_size: dealSize !== undefined ? dealSize : (existing?.typical_deal_size ?? null),
    sales_motion:      motion   !== undefined ? motion   : (existing?.sales_motion      ?? null),
  };

  db.prepare(`
    INSERT INTO user_context (user_id, company_name, what_we_sell, target_icp, our_positioning, typical_deal_size, sales_motion, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      company_name      = excluded.company_name,
      what_we_sell      = excluded.what_we_sell,
      target_icp        = excluded.target_icp,
      our_positioning   = excluded.our_positioning,
      typical_deal_size = excluded.typical_deal_size,
      sales_motion      = excluded.sales_motion,
      updated_at        = CURRENT_TIMESTAMP
  `).run(
    userId,
    merged.company_name, merged.what_we_sell, merged.target_icp, merged.our_positioning,
    merged.typical_deal_size, merged.sales_motion,
  );

  return { ok: true, context: getUserContext(userId) };
}

/**
 * Build the prompt-ready block. Returns '' when no meaningful context exists
 * — the caller is responsible for omitting the section entirely so the AI
 * never sees an empty "USER'S BUSINESS CONTEXT:" header.
 */
function formatContextForPrompt(ctx) {
  if (!hasMeaningfulContext(ctx)) return '';

  const dealSizeLabels = {
    small:      'small ($5K to $25K ACV)',
    mid:        'mid-market ($25K to $100K ACV)',
    large:      'large ($100K+ ACV)',
    enterprise: 'enterprise ($250K+ ACV)',
  };
  const motionLabels = {
    plg:    'PLG (product-led / self-serve)',
    slg:    'SLG (sales-led)',
    hybrid: 'hybrid (PLG + SLG)',
  };

  const lines = [];
  if (ctx.company_name)    lines.push(`Company: ${ctx.company_name}`);
  if (ctx.what_we_sell)    lines.push(`What we sell: ${ctx.what_we_sell}`);
  if (ctx.target_icp)      lines.push(`Target ICP: ${ctx.target_icp}`);
  if (ctx.our_positioning) lines.push(`Our positioning: ${ctx.our_positioning}`);
  if (ctx.typical_deal_size && dealSizeLabels[ctx.typical_deal_size]) {
    lines.push(`Typical deal size: ${dealSizeLabels[ctx.typical_deal_size]}`);
  }
  if (ctx.sales_motion && motionLabels[ctx.sales_motion]) {
    lines.push(`Sales motion: ${motionLabels[ctx.sales_motion]}`);
  }
  return lines.join('\n');
}

module.exports = {
  getUserContext,
  saveUserContext,
  hasMeaningfulContext,
  formatContextForPrompt,
  MAX_FIELD_CHARS,
  ALLOWED_DEAL_SIZES,
  ALLOWED_SALES_MOTIONS,
  FREE_TEXT_FIELDS,
};
