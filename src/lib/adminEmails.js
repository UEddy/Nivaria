// Single source of truth for admin identification, keyed off the ADMIN_EMAILS
// env var (comma-separated, case-insensitive, whitespace-trimmed). This is the
// same gate used by the /admin/* pages (src/routes/admin.js re-exports these).
//
// Lives in lib/ so both the route layer and the tier-limit layer can share one
// definition without a circular require (admin.js already depends on
// tierLimits.js).

// Parsed at call time so an env change takes effect on restart without code
// edits. Empty/unset → nobody is an admin (safe default).
function getAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).trim().toLowerCase());
}

module.exports = { getAdminEmails, isAdminEmail };
