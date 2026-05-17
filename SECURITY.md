# Security

This document describes the security controls in place for Foresight, how to report issues, and recommended production configuration.

---

## Security measures in place

### Authentication
- Email + password with OTP-based email verification on registration
- bcrypt password hashing with cost factor 12 (≥ 12 salt rounds)
- Passwords validated server-side: minimum 12 characters, uppercase, lowercase, number, special character, not matching the user's email, not in the top-100 common password list
- Maximum password length of 128 characters enforced before bcrypt to prevent DoS via oversized inputs
- Session ID regenerated on every successful login and registration (prevents session fixation attacks)
- `session_version` column on users: incremented on password reset, which invalidates all pre-existing sessions

### Session management
- Sessions stored in the database (`sessions` table), so they survive server restarts
- Session cookies: `httpOnly`, `secure` (production), `sameSite=strict`
- Default sessions are browser-session cookies (expire on browser close)
- "Remember me" option extends to 30 days via `cookie.maxAge`
- Sessions purged from the database hourly via `setInterval`

### CSRF protection
- CSRF token generated per-session, stored in the session, returned from `GET /api/auth/me`
- All mutation requests (`POST`, `PUT`, `DELETE`) to authenticated endpoints require an `X-CSRF-Token` header matching the session token
- Auth endpoints (login, register, forgot password) are exempt because they run before a session exists; `sameSite=strict` and `cors(origin: false)` protect them
- `cors({ origin: false })` rejects all cross-origin requests at the server level

### HTTP security headers (helmet)
| Header | Value |
|---|---|
| Content-Security-Policy | `default-src 'self'`; scripts/styles limited to `'self'` + Google Fonts |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `DENY` |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains; preload` |
| Referrer-Policy | `no-referrer` |
| X-XSS-Protection | `0` (modern browsers use CSP instead) |

### Rate limiting (express-rate-limit, in-memory store)
| Endpoint | Limit |
|---|---|
| `POST /api/auth/login` | 10 req / IP / 15 min |
| `POST /api/auth/register/request` | 5 req / IP / hour |
| `POST /api/auth/register/verify` | 10 req / IP / 15 min |
| `POST /api/auth/forgot/request` | 5 req / IP / hour |
| `POST /api/auth/forgot/verify` | 10 req / IP / 15 min |
| All other `/api/*` routes | 100 req / IP / 15 min |
| Per-email login attempts (in-DB) | 5 failures / 15 min → account temporarily locked |

### Input validation and sanitization
- All route inputs validated for type, length, and format before processing
- Competitor URLs: must be `http://` or `https://`, max 2048 characters
- Webhook URLs: must be `https://`, matched against expected provider hostnames (hooks.slack.com, discord.com)
- Email addresses: RFC-compliant regex, max 254 characters
- OTP codes: must be exactly 6 digits
- String length caps on all user-submitted fields (name: 100, description: 500, etc.)
- Request body size capped at 1 MB

### SQL injection
- All database queries use parameterized prepared statements via sql.js
- Zero raw string concatenation into SQL anywhere in the codebase

### XSS
- All user-generated content escaped before rendering via `esc()` in frontend templates
- Content-Security-Policy header restricts executable script sources
- **Known limitation:** CSP includes `'unsafe-inline'` for scripts due to an anti-flash theme snippet in static HTML files. A nonce-based CSP would eliminate this; planned for a future sprint.

### Authorization (IDOR prevention)
- Every database query for user-owned resources includes `AND user_id = ?` using the server-side `req.userId` (set by `requireAuth`, never from request body or params)
- Competitors, changes, and settings are always scoped to the authenticated user
- Returning 404 (not 403) for resources that belong to other users prevents user enumeration

### API secrets
- `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY` are server-side only
- No secrets are ever included in frontend JavaScript bundles or API responses
- `.env` is listed in `.gitignore`

### Logging
- Request logger records: method, path, status code, response time, masked IP (last octet hidden)
- No request bodies, passwords, OTP codes, session tokens, or API keys are ever logged
- Production error handler returns generic messages (`Something went wrong.`) instead of stack traces

---

## Reporting a security issue

Please report security vulnerabilities privately by emailing **security@foresight.com** (replace with your real address).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

Do not open a public GitHub issue for security-sensitive bugs. We aim to respond within 48 hours.

---

## Known limitations

1. **CSP `'unsafe-inline'`**: Required for the anti-flash theme detection snippet in `auth/index.html` and related static files. Mitigation: the script is first-party and does no external requests. A nonce-based CSP is the proper fix.

2. **In-memory rate limiter**: `express-rate-limit` uses an in-memory store by default. Limits reset on server restart and do not scale across multiple instances. Use a Redis store (`rate-limit-redis`) for multi-server deployments.

3. **sql.js session store**: Sessions are written to `data/competitor-shadow.db`. In a multi-server deployment you would need a shared session store (Redis, PostgreSQL) instead.

4. **No MFA**: Multi-factor authentication beyond email OTP is not yet implemented.

---

## Recommended production environment variables

```bash
NODE_ENV=production

# Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
SESSION_SECRET=<64-char random hex>

APP_URL=https://yourdomain.com

RESEND_API_KEY=re_...
RESEND_FROM=Foresight <noreply@yourdomain.com>

ANTHROPIC_API_KEY=sk-ant-...

# Stripe (when payments are live)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Additionally:
- Serve behind HTTPS (TLS 1.2+)
- Set `HSTS` preload via your DNS provider or CDN
- Rotate `SESSION_SECRET` periodically (this will force all users to re-authenticate)
- Enable database backups for `data/competitor-shadow.db`
