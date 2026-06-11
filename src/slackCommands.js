// Phase 9 — Slack slash command parsing, signature verification, and response
// builders. Pure functions, no DB or network, so they're trivially testable.
//
// Command shape (registered in Slack as "/foresight"):
//   /foresight lost-deal [DealName] [$Value] vs [Competitor]
//   /foresight won-deal  ContosoCorp $25K
//   /foresight stalled   Beta-Q4 $15K vs Workday
//
// Slack delivers `text` WITHOUT the leading "/foresight", so the first token of
// `text` is the outcome word.

const crypto = require('crypto');

// ── Value parsing ────────────────────────────────────────────────────────────
// Handles "$40K", "$40,000", "40k", "$40000", "1.5M", "40000". Returns integer
// dollars, or null when the token isn't a recognizable amount.
function parseDealValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase().replace(/[$,\s]/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(n * mult);
}

// Does a token look like a money amount (so we pull it out of the deal name)?
function looksLikeValueToken(tok) {
  return /^\$?\d[\d.,]*\s*(k|m|b)?$/i.test(String(tok).trim());
}

const OUTCOME_ALIASES = {
  'lost-deal': 'lost', 'lost': 'lost', 'loss': 'lost', 'lose': 'lost',
  'won-deal': 'won', 'won': 'won', 'win': 'won', 'win-deal': 'won',
  'stalled': 'stalled', 'stall': 'stalled', 'stalled-deal': 'stalled', 'stall-deal': 'stalled',
};

// Parse a slash command `text` into a structured deal intent.
// Returns { ok, outcome, deal_name, value_usd, value_raw, competitor_name, error }.
function parseSlackCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'empty_command' };
  }

  let tokens = trimmed.split(/\s+/);
  // Defensive: if someone pasted the whole "/foresight ..." string, drop it.
  if (tokens[0] && tokens[0].startsWith('/')) tokens = tokens.slice(1);
  if (tokens.length === 0) return { ok: false, error: 'empty_command' };

  const outcomeWord = tokens[0].toLowerCase();
  const outcome = OUTCOME_ALIASES[outcomeWord];
  if (!outcome) {
    return { ok: false, error: 'unknown_outcome', outcome_word: tokens[0] };
  }

  const rest = tokens.slice(1);

  // Split on a standalone "vs" (case-insensitive). Left = name + value,
  // right = competitor name.
  const vsIdx = rest.findIndex(t => t.toLowerCase() === 'vs' || t.toLowerCase() === 'vs.');
  let leftTokens, competitorName = null;
  if (vsIdx === -1) {
    leftTokens = rest;
  } else {
    leftTokens = rest.slice(0, vsIdx);
    const right = rest.slice(vsIdx + 1).join(' ').trim();
    competitorName = right || null;
  }

  // Pull out the value token (prefer one starting with "$").
  let valueRaw = null;
  let valueIdx = leftTokens.findIndex(t => t.startsWith('$') && looksLikeValueToken(t));
  if (valueIdx === -1) valueIdx = leftTokens.findIndex(t => looksLikeValueToken(t));
  if (valueIdx !== -1) {
    valueRaw = leftTokens[valueIdx];
    leftTokens = leftTokens.slice(0, valueIdx).concat(leftTokens.slice(valueIdx + 1));
  }

  const dealName = leftTokens.join(' ').trim();
  if (!dealName) {
    return { ok: false, error: 'missing_deal_name', outcome, competitor_name: competitorName };
  }

  return {
    ok: true,
    outcome,
    deal_name: dealName,
    value_usd: valueRaw !== null ? parseDealValue(valueRaw) : null,
    value_raw: valueRaw,
    competitor_name: competitorName,
  };
}

// Case-insensitive competitor match against a user's tracked list: exact first,
// then prefix, then substring. `competitors` is [{ id, name }].
function findCompetitorMatch(competitors, name) {
  if (!name) return null;
  const q = String(name).trim().toLowerCase();
  if (!q) return null;
  const list = competitors || [];
  return list.find(c => c.name.toLowerCase() === q)
      || list.find(c => c.name.toLowerCase().startsWith(q))
      || list.find(c => c.name.toLowerCase().includes(q))
      || null;
}

// ── Signature verification (with replay protection) ──────────────────────────
// Slack signs: v0=HMAC_SHA256(signingSecret, `v0:${timestamp}:${rawBody}`).
// We reject requests older than 5 minutes (replay window) and mismatched sigs.
function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!signingSecret) return { ok: false, reason: 'not_configured' };
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(now / 1000 - ts) > 300) return { ok: false, reason: 'stale_timestamp' };

  const base = `v0:${timestamp}:${rawBody || ''}`;
  const computed = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

// Test/helper: produce the headers Slack would send for a given body.
function signSlackRequest(signingSecret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  return { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature };
}

// ── Response builders (Slack message JSON) ───────────────────────────────────

function formatCompactMoney(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'K';
  return '$' + n;
}

function usageMessage() {
  return {
    response_type: 'ephemeral',
    text: [
      '*Nivaria deal logging*',
      'Usage: `/foresight <outcome> <deal name> [$value] [vs competitor]`',
      '',
      'Examples:',
      '• `/foresight lost-deal Acme $40K vs BambooHR`',
      '• `/foresight won-deal ContosoCorp $25K`',
      '• `/foresight stalled Beta-Q4 $15K vs Workday`',
      '',
      'Outcomes: `lost-deal` / `won-deal` / `stalled`. A competitor is required for lost and stalled deals.',
    ].join('\n'),
  };
}

function notLinkedMessage(appUrl) {
  return {
    response_type: 'ephemeral',
    text: `Your Slack account isn't linked to Nivaria yet. Open <${appUrl}/app#/settings/integrations|Settings in Nivaria> and click "Add to Slack" to connect, then try again.`,
  };
}

function confirmationMessage({ outcome, deal_name, value_usd, competitor_name, appUrl }) {
  const parts = [outcome, deal_name];
  const money = formatCompactMoney(value_usd);
  if (money) parts.push(money);
  if (competitor_name) parts.push(`vs ${competitor_name}`);
  const summary = parts.join(' ');
  return {
    response_type: 'ephemeral', // value stays private to the logging user
    text: `:white_check_mark: Logged: *${summary}* · close date today · <${appUrl}/app#/deals|view in Nivaria>`,
  };
}

// When the named competitor doesn't match a tracked one, ask the user to pick
// via interactive buttons. `pending` carries the parsed deal so the
// interactions handler can finish the job. competitors is [{id,name}].
function competitorPickerMessage({ pending, competitors, appUrl }) {
  const top = (competitors || []).slice(0, 10);
  const namePart = pending.competitor_name
    ? `I couldn't match "*${pending.competitor_name}*" to a competitor you track.`
    : 'Which competitor was this deal against?';
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `${namePart}\nPick one to log *${pending.outcome} ${pending.deal_name}*:` } },
  ];
  if (top.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `You have no tracked competitors yet. Add one in <${appUrl}/app#/competitors|Nivaria> first.` } });
  } else {
    blocks.push({
      type: 'actions',
      elements: top.map(c => ({
        type: 'button',
        text: { type: 'plain_text', text: c.name.slice(0, 75) },
        action_id: `pick_competitor_${c.id}`,
        value: JSON.stringify({ ...pending, competitor_id: c.id }),
      })),
    });
  }
  return { response_type: 'ephemeral', blocks };
}

module.exports = {
  parseDealValue, looksLikeValueToken, parseSlackCommand, findCompetitorMatch,
  verifySlackSignature, signSlackRequest,
  formatCompactMoney, usageMessage, notLinkedMessage, confirmationMessage, competitorPickerMessage,
  OUTCOME_ALIASES,
};
