// Phase 8 — /api/user/voice-profile routes.
//
// GET → returns the caller's profile, or DEFAULTS-shaped empty values when
//       no row exists yet. The SPA never needs a null-check.
// PUT → upserts the row, validating enums + length caps.
//
// Auth/CSRF is mounted by server.js, so req.userId is guaranteed. Every
// query is scoped to req.userId — no row id is ever accepted from the
// request body.

const express = require('express');
const router  = express.Router();
const {
  getVoiceProfile, saveVoiceProfile,
  DEFAULTS,
  MAX_SHORT_FIELD_CHARS, MAX_LONG_FIELD_CHARS,
  ALLOWED_FORMALITY, ALLOWED_CONTRACTIONS, ALLOWED_OPENER_STYLE, ALLOWED_RHYTHM,
} = require('../voiceProfile');

router.get('/', (req, res) => {
  const row = getVoiceProfile(req.userId);
  res.json({
    exists: !!row,
    profile: row || {
      formality: null, contraction_style: null, opener_style: null, sentence_rhythm: null,
      sign_off_examples: '', voice_sample: '', avoid_phrases: '',
    },
    defaults: DEFAULTS,
    constraints: {
      max_short_field_chars: MAX_SHORT_FIELD_CHARS,
      max_long_field_chars:  MAX_LONG_FIELD_CHARS,
      formality:             ALLOWED_FORMALITY,
      contraction_style:     ALLOWED_CONTRACTIONS,
      opener_style:          ALLOWED_OPENER_STYLE,
      sentence_rhythm:       ALLOWED_RHYTHM,
    },
  });
});

router.put('/', (req, res) => {
  const allowed = ['formality', 'contraction_style', 'opener_style', 'sentence_rhythm',
                   'sign_off_examples', 'voice_sample', 'avoid_phrases'];
  const patch = {};
  for (const k of allowed) {
    if (k in req.body) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'No voice profile fields provided' });
  }

  const r = saveVoiceProfile(req.userId, patch);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true, profile: r.profile });
});

module.exports = router;
