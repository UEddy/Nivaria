# 🔍 Foresight

*AI-powered competitor intelligence for B2B sales teams.*

## Overview

Foresight watches competitor websites on a schedule, detects meaningful changes, and uses Claude to turn each diff into a structured battle card with threat scoring and a recommended response. Sales teams learn about a competitor's new pricing, feature launch, or messaging shift the day it ships, not weeks later from a deal they lost. The product replaces a manual research process that most B2B teams either skip entirely or assign to whoever has the least to do.

## Why I built this

I built Foresight in 48 hours using Claude Code, end to end, as a demonstration that I can scope, design, and ship a real full-stack product on a short clock. Every architectural decision was directed by me: the WASM SQLite choice over a native driver, the synchronous DB adapter, the DB-backed session store, the tier-enforcement layer, the multi-step OTP authentication flow, and the AI prompt structure for battle cards. Claude Code wrote code; I made the calls. The point was to show velocity and judgment together, not just velocity.

## Features

- Email and OTP-based authentication with verification on registration
- Password reset flow with rate-limited OTP delivery
- Three-tier pricing (Free, Pro, Team) with usage enforcement on every protected route
- Competitor monitoring dashboard with paused or active state and per-source change history
- AI-generated battle cards: headline, summary, threat score (low, medium, high), recommended response, and sales talking points
- Slack and Discord webhook alerts when changes are detected
- Daily scheduled checks via cron, with per-competitor manual re-check
- Three-mode theme system (system, light, dark) with anti-flash inline detection

## Tech stack

- **Backend**: Node.js, Express
- **Database**: SQLite via sql.js (pure WASM, no native compilation step)
- **AI**: Anthropic API (Claude Sonnet 4.6)
- **Email**: Resend for OTP delivery
- **Sessions**: express-session with a DB-backed store
- **Auth**: bcrypt password hashing with server-side session invalidation
- **Frontend**: Vanilla JS SPA, no framework runtime, dark-first design

## Screenshots

![Landing page](screenshots/landing.png)

![Dashboard](screenshots/dashboard.png)

![Battle card](screenshots/battlecard.png)

## Running locally

1. Clone the repository:
   ```bash
   git clone https://github.com/UEddy/Foresight.git
   cd Foresight
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a local environment file from the template:
   ```bash
   cp .env.example .env
   ```
   At minimum, set `ANTHROPIC_API_KEY` and `RESEND_API_KEY` in the new `.env`. Stripe variables are optional.
4. Start the server:
   ```bash
   npm start
   ```
5. Open http://localhost:3000. Demo data is seeded on first run, and demo credentials are printed to the console.

## Roadmap

### Next 7 days

- Live Stripe payment integration (currently stubbed in `src/payments.js`)
- Production security hardening: nonce-based CSP, Redis-backed rate limiter, shared session store
- Deploy to a production environment behind HTTPS

### Next 30 days

- Pre-meeting briefings: auto-generated summary for an upcoming sales call
- Slack slash commands for on-demand competitor lookups
- Win/loss tagging tied to competitor activity, surfacing patterns over time
- Vertical-specific battle card templates (fintech, devtools, healthcare)

---

Built by Ediong Udotong.
