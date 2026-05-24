// Phase 8 — per-user voice calibration profile.
//
// One row per user. Drives the playbook generator: formality, contractions,
// opener style, sentence rhythm, sign-off examples, free-text voice sample,
// and a phrases-to-avoid list. All fields are optional — when nothing is set
// we use sensible defaults (balanced / sometimes / direct / mixed).
//
// Security: every read and write is scoped by user_id. voice_sample and
// avoid_phrases are user-supplied free text and are NOT sanitized here —
// the playbook module (src/playbooks.js) wraps them in tagged data blocks
// at prompt-injection time. We just cap length to bound token cost.

const { getDb } = require('./db');

const MAX_SHORT_FIELD_CHARS = 1000;    // sign_off_examples, avoid_phrases
const MAX_LONG_FIELD_CHARS  = 4000;    // voice_sample (1-2 short emails)

const ALLOWED_FORMALITY     = ['casual', 'balanced', 'formal'];
const ALLOWED_CONTRACTIONS  = ['always', 'sometimes', 'never'];
const ALLOWED_OPENER_STYLE  = ['direct', 'warm', 'context-first'];
const ALLOWED_RHYTHM        = ['short_punchy', 'mixed', 'measured'];

const DEFAULTS = Object.freeze({
  formality:         'balanced',
  contraction_style: 'sometimes',
  opener_style:      'direct',
  sentence_rhythm:   'mixed',
  sign_off_examples: '',
  voice_sample:      '',
  avoid_phrases:     '',
});

function cleanShort(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, MAX_SHORT_FIELD_CHARS);
}

function cleanLong(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, MAX_LONG_FIELD_CHARS);
}

function getVoiceProfile(userId) {
  if (!Number.isInteger(userId)) throw new Error('getVoiceProfile: userId required');
  const db = getDb();
  const row = db.prepare(`
    SELECT id, user_id, formality, contraction_style, opener_style, sentence_rhythm,
           sign_off_examples, voice_sample, avoid_phrases, created_at, updated_at
    FROM user_voice_profile WHERE user_id = ?
  `).get(userId);
  return row || null;
}

/**
 * Returns the user's profile merged on top of DEFAULTS so callers (the
 * playbook generator) never have to null-check. The returned object always
 * has all fields populated.
 */
function getProfileWithDefaults(userId) {
  const row = getVoiceProfile(userId);
  return {
    ...DEFAULTS,
    ...(row ? {
      formality:         row.formality         || DEFAULTS.formality,
      contraction_style: row.contraction_style || DEFAULTS.contraction_style,
      opener_style:      row.opener_style      || DEFAULTS.opener_style,
      sentence_rhythm:   row.sentence_rhythm   || DEFAULTS.sentence_rhythm,
      sign_off_examples: row.sign_off_examples || '',
      voice_sample:      row.voice_sample      || '',
      avoid_phrases:     row.avoid_phrases     || '',
    } : {}),
  };
}

function saveVoiceProfile(userId, fields) {
  if (!Number.isInteger(userId)) throw new Error('saveVoiceProfile: userId required');

  const normEnum = (val, allowed, name) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    const v = String(val).toLowerCase().trim();
    if (!allowed.includes(v)) return { error: `${name} must be one of: ${allowed.join(', ')}` };
    return v;
  };

  const formality        = normEnum(fields.formality,         ALLOWED_FORMALITY,    'formality');
  if (formality && formality.error)        return { ok: false, error: formality.error };
  const contractions     = normEnum(fields.contraction_style, ALLOWED_CONTRACTIONS, 'contraction_style');
  if (contractions && contractions.error)  return { ok: false, error: contractions.error };
  const opener           = normEnum(fields.opener_style,      ALLOWED_OPENER_STYLE, 'opener_style');
  if (opener && opener.error)              return { ok: false, error: opener.error };
  const rhythm           = normEnum(fields.sentence_rhythm,   ALLOWED_RHYTHM,       'sentence_rhythm');
  if (rhythm && rhythm.error)              return { ok: false, error: rhythm.error };

  // Length-cap free text. We return an error so the user sees feedback
  // instead of silently truncating their pasted email.
  if (fields.sign_off_examples !== undefined && fields.sign_off_examples !== null
      && String(fields.sign_off_examples).length > MAX_SHORT_FIELD_CHARS) {
    return { ok: false, error: `sign_off_examples must be ${MAX_SHORT_FIELD_CHARS} characters or fewer` };
  }
  if (fields.avoid_phrases !== undefined && fields.avoid_phrases !== null
      && String(fields.avoid_phrases).length > MAX_SHORT_FIELD_CHARS) {
    return { ok: false, error: `avoid_phrases must be ${MAX_SHORT_FIELD_CHARS} characters or fewer` };
  }
  if (fields.voice_sample !== undefined && fields.voice_sample !== null
      && String(fields.voice_sample).length > MAX_LONG_FIELD_CHARS) {
    return { ok: false, error: `voice_sample must be ${MAX_LONG_FIELD_CHARS} characters or fewer` };
  }

  const db = getDb();
  const existing = getVoiceProfile(userId);

  const merged = {
    formality:         formality    !== undefined ? formality    : (existing?.formality         ?? null),
    contraction_style: contractions !== undefined ? contractions : (existing?.contraction_style ?? null),
    opener_style:      opener       !== undefined ? opener       : (existing?.opener_style      ?? null),
    sentence_rhythm:   rhythm       !== undefined ? rhythm       : (existing?.sentence_rhythm   ?? null),
    sign_off_examples: fields.sign_off_examples !== undefined ? cleanShort(fields.sign_off_examples) : (existing?.sign_off_examples ?? null),
    voice_sample:      fields.voice_sample      !== undefined ? cleanLong (fields.voice_sample)      : (existing?.voice_sample      ?? null),
    avoid_phrases:     fields.avoid_phrases     !== undefined ? cleanShort(fields.avoid_phrases)     : (existing?.avoid_phrases     ?? null),
  };

  db.prepare(`
    INSERT INTO user_voice_profile (user_id, formality, contraction_style, opener_style, sentence_rhythm,
                                     sign_off_examples, voice_sample, avoid_phrases, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      formality         = excluded.formality,
      contraction_style = excluded.contraction_style,
      opener_style      = excluded.opener_style,
      sentence_rhythm   = excluded.sentence_rhythm,
      sign_off_examples = excluded.sign_off_examples,
      voice_sample      = excluded.voice_sample,
      avoid_phrases     = excluded.avoid_phrases,
      updated_at        = CURRENT_TIMESTAMP
  `).run(
    userId,
    merged.formality, merged.contraction_style, merged.opener_style, merged.sentence_rhythm,
    merged.sign_off_examples, merged.voice_sample, merged.avoid_phrases,
  );

  return { ok: true, profile: getVoiceProfile(userId) };
}

/**
 * Parse the user's free-text avoid_phrases field into a comma-separated array
 * of normalized phrases. Used by the playbook generator both at prompt time
 * (to instruct the AI) and at post-hoc validation time (to enforce).
 */
function parseAvoidPhrases(text) {
  if (!text) return [];
  return String(text)
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^["'`]|["'`]$/g, ''))
    .slice(0, 50);
}

module.exports = {
  getVoiceProfile,
  getProfileWithDefaults,
  saveVoiceProfile,
  parseAvoidPhrases,
  DEFAULTS,
  MAX_SHORT_FIELD_CHARS,
  MAX_LONG_FIELD_CHARS,
  ALLOWED_FORMALITY,
  ALLOWED_CONTRACTIONS,
  ALLOWED_OPENER_STYLE,
  ALLOWED_RHYTHM,
};
