# Nivaria Security Backlog

This document tracks security improvements deferred from the pre-launch audit. None of these are critical or block launch; all have existing mitigations in place.

## Pre-launch audit summary

Conducted: 2026-06-10
Findings addressed pre-launch:
- Finding 2a: Cryptographic OTP generation (commit 63e1da2)
- Finding 2b: Per-email OTP verification lockout (commit 63e1da2)
- Finding 10: Non-breaking dependency advisories (commit a6f8336)

## Deferred items (post-launch)

### Medium priority

**Finding 4a: Move CSP to nonce-based**
- Current state: CSP allows 'unsafe-inline' for scripts due to inline event handlers and theme initialization snippet
- Risk: Reduces CSP's value as second line of defense against XSS
- Mitigation in place: Output encoding via esc() throughout frontend
- Effort: Medium (refactor inline handlers to addEventListener, add nonce generation)
- Target: Phase 14 or post-Phase 13 hardening sprint

### Low priority

**Finding 4b: Explicit href scheme validation at render**
- Current state: Competitor URL input validation rejects non-http/https schemes; href rendering doesn't re-check
- Risk: If input validation is ever bypassed, javascript: schemes could become exploitable
- Mitigation in place: Input validation at competitor create/update
- Effort: Small (add scheme check in esc() for href contexts)
- Target: Phase 14

**Finding 10b: Major version bumps**
- uuid: bump from current to v14 (semver-major, requires smoke testing)
- node-cron: bump from current to v4 (semver-major, requires smoke testing)
- Current state: Both have moderate advisories but vulnerable code paths are unused
- Effort: Small-medium (smoke test all OTP/email/scheduling flows)
- Target: First post-launch security sprint

### Future hardening (post-PMF, when growth and team allow)

- Add frame-ancestors CSP directive to complement X-Frame-Options
- 2FA support for user accounts (TOTP via authenticator apps)
- Hardware security key support for admin accounts
- Revisit user_id vs workspace_id scoping when Phase 10.5 / Team tier launches
- Run OWASP ZAP scan quarterly as ongoing maintenance
- Audit headers via securityheaders.com periodically
- Document incident response process
- Consider SOC 2 readiness when enterprise customers materialize
- Bug bounty program when team can triage submissions
- Encrypted database backups (beyond Railway's standard persistence)

## Maintenance cadence

- npm audit: weekly check, address criticals immediately
- Dependency updates: monthly security-driven, quarterly feature-driven
- Security audit refresh: annually or before major releases
- Penetration testing: when revenue justifies (~$5K-15K range)
