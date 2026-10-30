# The original monitoring product

Nivaria began as competitive intelligence for B2B sales teams, and that product
still ships in this codebase. Everything Qloo-powered (see the
[README](../README.md)) runs with `PRODUCT_MODE=taste`. Leave `PRODUCT_MODE`
unset to run the monitoring product instead.

## What it does

- **Page monitoring.** It watches competitor web pages on a schedule with
  Playwright (`ENABLE_SCRAPER` not set to `false`; `npm install` only downloads
  the browser when `ENABLE_SCRAPER=true`).
- **Change briefs.** Each meaningful change becomes a Claude-written brief with
  a threat level and talking points (`src/analyzer.js`), and an alert to Slack
  or Discord.
- **Pre-meeting briefings.** It can push a briefing before calendar meetings
  that mention a tracked competitor (`src/briefingDispatch.js`).
- **Win/loss.** It correlates win/loss deals with competitor activity.
- **Integrations.** Google Calendar, Slack deal logging and Sign in with
  Google, configured through the variables documented in `.env.example`.

There is no billing in either product. Every account is on one fixed plan,
defined in `src/lib/tierLimits.js`.

## Tests

The `test-*.js` files that do not start with `test-taste-` (apart from
`test-qloo-rate.js`, `test-demo-login.js` and `test-sanitize-text.js`) belong to
this product. The `*-live` ones call real APIs.

## Other documents from this era

- [roadmap.md](roadmap.md): the post-launch roadmap for the monitoring product
- [phase-10.5-prerequisites.md](phase-10.5-prerequisites.md): prerequisites for multi-user workspaces
- [security-backlog.md](security-backlog.md): security items deferred from the pre-launch audit
