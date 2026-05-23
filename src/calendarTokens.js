// Phase 7 — calendar OAuth token encryption.
//
// AES-256-GCM at rest. Tokens are only ever decrypted in-process when a
// calendar API call is about to be made; nothing logged or returned over
// the wire.
//
// Key handling: CALENDAR_TOKEN_ENCRYPTION_KEY must be a 32-byte hex string
// (64 hex chars). If it's missing or malformed, every code path that needs
// to encrypt/decrypt throws — we deliberately fail loud rather than running
// with plaintext tokens.
//
// Format: `<iv>.<authTag>.<ciphertext>` where each segment is base64.
// Future-proofing: a leading "v1." version tag is included so we can rotate
// the key or algorithm later without ambiguity.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY;
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      'CALENDAR_TOKEN_ENCRYPTION_KEY is not set. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('CALENDAR_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  cachedKey = Buffer.from(trimmed, 'hex');
  return cachedKey;
}

function isConfigured() {
  try { loadKey(); return true; } catch (_) { return false; }
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = loadKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(blob) {
  if (blob === null || blob === undefined || blob === '') return null;
  const key = loadKey();
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Encrypted token has an unexpected format or version.');
  }
  const iv  = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct  = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Test seam — lets tests reset the cached key after mutating env.
function _resetCachedKeyForTests() { cachedKey = null; }

module.exports = { encrypt, decrypt, isConfigured, _resetCachedKeyForTests };
