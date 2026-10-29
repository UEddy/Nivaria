<p align="center">
  <img src="public/assets/og-image.png" alt="Nivaria: see the audiences your rival owns, and which to win first" width="760">
</p>

<h1 align="center">Nivaria</h1>

<p align="center">
  <strong>Audience intelligence for consumer brands, powered by Qloo Taste AI.</strong><br>
  See the audiences your rival owns, where they are on the map, and which to win first.
</p>

<p align="center">
  <a href="https://nivaria.app">Live site</a> ·
  <a href="#try-it">Try it</a> ·
  <a href="#how-a-brief-is-built">How it works</a> ·
  <a href="#running-locally">Run locally</a> ·
  <a href="#deploying">Deploy</a> ·
  <a href="LICENSE">MIT license</a>
</p>

---

## What Nivaria does

Name your brand and one or two rivals, or leave the rival blank and let the agent find them. An AI agent then researches both audiences with Qloo's Taste AI and writes a brief that answers three questions:

1. **Where is the rival's audience that ours is not?** Taste segments in music, film, TV, places and other brands where the rival's audience over-indexes and yours does not.
2. **Where on the map?** Add a city and both audiences are compared neighborhood by neighborhood, with the hotspots worth a campaign numbered and named.
3. **Which segments should we win first?** A ranked plan, each pick with the reason, a campaign hook built from the actual tastes, and concrete channels.

Every number in a brief is a Qloo score attached by the server. The model cites Qloo results by reference and never writes a score itself, and a claim it cannot back with a Qloo result is dropped. You watch the agent work in a live trace while it runs.

## Try it

Open **[nivaria.app](https://nivaria.app)** and click **Try the live demo**. It signs you straight into a shared demo account, with no form, no email code and no signup, and lands you on the dashboard:

- **Featured briefs** are ready to open instantly: ten well-known rival pairs (Starbucks vs Dunkin' in New York, Glossier vs Fenty Beauty, Nike vs Adidas in Los Angeles and more), served from the database with no wait.
- **Run your own** by typing a brand and, optionally, a rival and a city. Brand names autocomplete from Qloo. A fresh brief takes up to about three minutes.
- **Leave the rival blank** to watch the agent choose who to compare against.

The demo account is shared by every visitor, so briefs run there are visible to other demo visitors, and the app says so in a banner. The account cannot be deleted, renamed or have its password changed.

## What's in a brief

| Section | What it shows |
|---|---|
| **Rivals chosen by the agent** | When no rival was named: every brand Qloo found with an overlapping audience, the one or two the agent picked, and its one-sentence reason citing the Qloo numbers. |
| **Headline and summary** | The finding and the move, in two or three sentences. |
| **Win these first** | A ranked plan. Each pick has the reason, a campaign hook built from real tastes (a show, an artist, a venue, a neighborhood) and concrete channels. |
| **Taste segments the rival owns** | Clusters of artists, films, shows, places and brands, each with the entities behind it and both audiences' Qloo scores. |
| **Where on the map** | A city map of every heatmap cell, colored by which audience leads, with the rival's hotspots numbered and labelled ("neighborhood, borough"). |
| **Who the audiences are** | Age and gender mix of both audiences on one chart, with a table view. |
| **Positioning** | The Qloo tags both brands share and the ones only the rival carries. |
| **How the numbers were checked** | How many Qloo data points back the brief, how many citations were dropped, the Qloo endpoints called (with counts), and the model that wrote it. |
| **How the agent built this brief** | The full trace: every lookup, comparison and decision, with timings. |

A finished brief can be **shared** as a public, read-only link (`/share/<token>`: unguessable, never indexed, revocable) or **sent to Slack or Discord** as a summary with the link.

## How a brief is built

The agent is a real tool-use loop. The model decides which Qloo comparisons to run, runs independent ones in parallel, and finishes by submitting a structured brief. The server checks every citation in it against the Qloo results from that run.

```
 brand, rivals (optional), city (optional)
        │
        ▼
 ┌──────────────────────────── agent loop (src/taste/agent.js) ────────────────────────────┐
 │  1. resolve      search_brands, find_city                                               │
 │  2. discover     discover_rivals, choose_rivals          (only when no rival was named) │
 │  3. compare      audience_gap per domain, geo_gap, demographic_gap, brand_positioning   │
 │                  (independent calls run in parallel)                                    │
 │  4. submit       submit_brief, citing Qloo rows by ref                                  │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
        │                                          ▲
        ▼                                          │ every step streams to the live trace
 Qloo Taste AI (src/qloo/client.js)                │ (server-sent events)
        │
        ▼
 assembleBrief: resolve every citation to its Qloo row and attach the scores,
 drop what does not resolve, sanitize the prose, then store and cache the brief
```

### The tools, and the Qloo calls behind them

| Tool | Qloo endpoint | What it does |
|---|---|---|
| `search_brands` | `/search` (brands) | Resolves a brand name. Also powers the form's autocomplete. |
| `find_city` | `/search` (localities) | Resolves the city. Qloo can rank a state or county above the city with the same name ("New York", "Los Angeles"), so the city is picked from the result's place type, and its outline is kept for later. |
| `discover_rivals` | `/v2/insights`, `filter.type=urn:entity:brand` | With our brand as the signal: the brands our audience over-indexes on, with affinity, the Qloo tags each shares with our brand, and flags for what is not a competitor (same brand family, parent company, same owner, retailer). |
| `choose_rivals` | none | Records the agent's one or two picks and its reason. The server checks every pick is a discovered candidate and not our brand, and no brief is accepted before the choice. |
| `audience_gap` | `/v2/insights`, then cross-scoring with `filter.results.entities` | Takes the rival audience's top entities in a domain (artists, films, TV shows, places, other brands), then scores exactly those entities for our audience. The difference is the gap. Places outside the city's outline are dropped. |
| `geo_gap` | `/v2/insights`, `filter.type=urn:heatmap` | Both brands' heatmaps for the city land on the same grid and are joined cell by cell. The hotspots are named with a further Insights call per cell. |
| `demographic_gap` | `/v2/insights`, `filter.type=urn:demographics` | Age and gender affinity for both audiences. |
| `brand_positioning` | `/v2/analysis/compare` | The tags both brands share, and the ones only one side carries. |
| `submit_brief` | none | The structured brief, citing Qloo rows by short refs (`e3` for an entity, `c2` for a map cell). |

Limits per run: 15 model turns and a three-minute deadline. Near the end, only `submit_brief` stays available.

## Why the numbers can be trusted

- **Scores come from Qloo, never the model.** Tool results reach the model as compact rows with short refs, and the brief cites those refs. The server swaps each ref for the Qloo row behind it, and drops and counts any citation that does not resolve.
- **Unsupported traits are removed.** The prompt allows describing audiences only by their tastes, places, age and gender, never by income, education, class or protected traits. As a backstop, a sentence that names a trait no tool returned is dropped, and the run's warnings say so.
- **The trace hides internals.** The model's narration is shown with every internal ref replaced by the name it stands for.
- **House style is enforced.** All model output passes through `src/lib/sanitizeText.js`, which removes em-dashes, en-dashes and "+" used as a connector, as `CLAUDE.md` requires.

## Privacy

Prompts go to third-party model APIs, some on free tiers that may keep them. So the only outside input that ever reaches a prompt is the brand, rivals and city typed for that run, capped in length and scrubbed of anything shaped like an email address or phone number. The agent modules under `src/taste` and `src/qloo` cannot import the database or session code, and `test-taste-privacy.js` checks that, along with the input scrubbing and the request actually sent to a provider.

## Caching and fair use

- **Brief cache:** a pair that already has a good brief from the last 14 days opens instantly with no Qloo or model calls. Featured briefs always do. A run whose rivals were discovered is cached under the rivals the agent chose.
- **Fresh runs:** limited per visitor IP rather than per account, because demo visitors share one account. That's 3 fresh runs per IP in 24 hours (`TASTE_FRESH_PER_DAY`), one at a time. Admins (`ADMIN_EMAILS`) are not limited.
- **Qloo's rate limit:** every Qloo call goes through one client that spaces requests to stay under Qloo's 10 per second, retries a 429 with backoff, and caches identical requests in memory. `test-qloo-rate.js` checks this under load.

## The model chain

The agent is provider-neutral. `src/taste/llm.js` keeps one transcript and renders it for each provider. If a model fails (a 429, a 5xx or a timeout after one retry, or a bad key), the run moves to the next model in the chain and keeps the whole conversation.

| Provider | Default model | Notes |
|---|---|---|
| Gemini | `gemini-3.6-flash`, then `gemini-3.5-flash` | Default first choice. Each model has its own free daily quota. |
| Groq | `qwen/qwen3.8-27b` | Older tool results are trimmed to fit the free tier's input limit. |
| OpenRouter | free Nemotron models | `OPENROUTER_MODELS` overrides the list. |
| Z.ai | `glm-4.7-flash` | Not in the default chain. Add `zai` to `LLM_CHAIN`. |
| Anthropic | `claude-sonnet-4-6` | Not in the default chain. Add `anthropic` to `LLM_CHAIN`. |
| Scripted stand-in | none | `LLM_CHAIN=scripted`: a fixed script over the real Qloo tools, for building and demoing without spending model quota. Featured briefs are not written when it is the only model configured. |

`LLM_CHAIN` sets the order (for example `gemini,gemini:gemini-3.5-flash,groq,openrouter`). Providers without a key are skipped.

## Architecture

| Layer | Stack |
|---|---|
| Server | Node.js 20+, Express 4, helmet (CSP), express-rate-limit |
| Database | SQLite through sql.js (WebAssembly, no native build), one file on disk |
| Sessions | express-session with a database-backed store, CSRF double-submit tokens |
| Taste data | Qloo Taste AI (hackathon API) |
| Models | Gemini, Groq, OpenRouter and Z.ai over their OpenAI-compatible APIs, and Anthropic through its SDK |
| Frontend | Vanilla JavaScript single-page app, light and dark themes, Leaflet with OpenStreetMap tiles for the map |
| Email | Resend, for sign-up and password reset codes |

| Path | What it holds |
|---|---|
| `src/qloo/client.js` | Qloo HTTP client: auth header, request spacing, 429 backoff, in-memory cache |
| `src/qloo/tools.js` | The agent's Qloo tools and their compact results |
| `src/taste/agent.js` | The agent loop, system prompt, brief assembly and citation checks |
| `src/taste/llm.js` | Provider adapters and the fallback chain |
| `src/taste/scripted.js` | The scripted model stand-in |
| `src/tasteRuns.js` | Run storage, the background runner, the live trace, the brief cache and per-visitor limits |
| `src/tasteFeatured.js` | The ten featured pairs and their boot-time generation |
| `src/tasteShares.js` | Share links and the Slack and Discord summary |
| `src/routes/taste.js` | The API under `/api/taste` |
| `src/routes/tasteShare.js` | Public shared brief pages under `/share/<token>` |
| `src/lib/demoAccount.js` | The shared demo account |
| `public/index.html` | The landing page |
| `public/js/taste.js` | The dashboard, brief, map, chart, trace and runs views |
| `deploy/` | Droplet setup and update scripts, the systemd unit, the Caddyfile and the deploy checklist |

## Running locally

Requires Node.js 20 or later.

```bash
git clone https://github.com/UEddy/Nivaria.git
cd Nivaria
npm install
```

`npm install` skips Playwright's browser download unless `ENABLE_SCRAPER=true`. The browser is only needed by the original monitoring product.

### Offline, with no keys at all

The scripted stand-in plays the model, and a fake Qloo answers with synthetic data. Every screen works, including rival discovery, and nothing calls an outside service:

```bash
PRODUCT_MODE=taste LLM_CHAIN=scripted \
DEMO_LOGIN_EMAIL=demo@localhost.test DEMO_LOGIN_PASSWORD=local-demo-password \
node -r ./scripts/qloo-fake.js src/server.js
```

Open http://localhost:3000 and click **Try the live demo**. The featured briefs stay empty in this mode, because they are never written by the stand-in.

### With real Qloo data and models

```bash
cp .env.example .env
```

In `.env`, set at least:

```
PRODUCT_MODE=taste
QLOO_API_KEY=your_qloo_api_key
QLOO_BASE_URL=https://hackathon.api.qloo.com
GEMINI_API_KEY=your_gemini_api_key
DEMO_LOGIN_EMAIL=demo@localhost.test
DEMO_LOGIN_PASSWORD=a_password_of_at_least_12_characters
```

Then run `npm start` and open http://localhost:3000. On first boot, the first two featured briefs are generated in the background. To check rival discovery against the real API without spending model quota, run `node scripts/qloo-discover.js Starbucks Glossier`.

Signing up with your own email needs `RESEND_API_KEY`, because sign-up confirms the address with a code. The demo login needs no email.

## Configuration

`.env.example` documents every variable. These are the ones that matter for Nivaria:

| Variable | Purpose |
|---|---|
| `PRODUCT_MODE` | `taste` runs Nivaria as described here. Unset runs the original monitoring product. |
| `SESSION_SECRET` | Required in production. The server refuses to start without a real one. |
| `APP_URL` | The public address. Share links and email links are built from it. |
| `QLOO_API_KEY`, `QLOO_BASE_URL` | Qloo access. The hackathon key only works on `https://hackathon.api.qloo.com`. |
| `LLM_CHAIN` | Model order. Unset uses Gemini, the second Gemini model, Groq, then OpenRouter. |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `ANTHROPIC_API_KEY` | Provider keys. Any provider without a key is skipped. |
| `DEMO_LOGIN_EMAIL`, `DEMO_LOGIN_PASSWORD` | The shared demo account and the **Try the live demo** button. Unset means no demo. |
| `TASTE_FRESH_PER_DAY` | Fresh runs per visitor IP in 24 hours (default 3). |
| `TASTE_EXAMPLES` | Boot-time featured briefs: unset fills the missing ones, `refresh` rewrites the boot pairs, `off` skips them. |
| `FEATURED_CHAIN` | The models `scripts/generate-featured.js` uses (default: both Gemini models). |
| `ADMIN_EMAILS` | Accounts that skip the daily limit and can open `/admin`. |
| `RESEND_API_KEY`, `RESEND_FROM` | Email for sign-up and password reset codes. `RESEND_FROM` takes the form `Nivaria <noreply@your-domain>`. |
| `ENABLE_SCRAPER` | `false` turns page monitoring off (no browser, no daily checks). |
| `DATABASE_PATH` | Where the SQLite file lives (default `data/competitor-shadow.db`). |

## Deploying

### A droplet with systemd and Caddy

`deploy/CHECKLIST.md` is a step-by-step guide to follow over SSH.

1. Point DNS for the domain at the server.
2. Run `deploy/setup.sh` once as root. It adds swap, installs Node 20 and Caddy, enables the firewall (SSH, 80 and 443 only), creates the `nivaria` user, clones the repo to `/opt/nivaria` and installs the systemd service and the Caddyfile.
3. Create `/opt/nivaria/.env` and start the service.

Caddy serves HTTPS on its own. The service runs with `PRODUCT_MODE=taste`, page monitoring off and a 350 MB memory limit. To update to the latest `main`, run `bash /opt/nivaria/deploy/update.sh`.

### Docker

```bash
cp .env.example .env    # set SESSION_SECRET, QLOO_API_KEY, a model key and the demo login
docker compose up -d --build
```

The image runs Nivaria in `taste` mode with page monitoring off, listens on `127.0.0.1:3000` only and keeps the database on the `nivaria-data` volume. Put a reverse proxy with HTTPS in front of it, because session cookies are Secure in production.

### Writing the featured briefs

On a fresh database the first two featured pairs are written at boot. To write all ten with Gemini, run this on the server while the service is up:

```bash
cd /opt/nivaria && sudo -u nivaria node scripts/generate-featured.js
# Docker: docker compose exec nivaria node scripts/generate-featured.js
```

It asks the running server to write each brief, skips pairs that are already done, stops cleanly when Gemini's quota runs out, and can be run again to resume.

## Tests

Each test is a plain Node script that runs offline, on a throwaway database, with the fake Qloo and the scripted stand-in:

```bash
for t in test-taste-*.js test-qloo-rate.js test-demo-login.js test-sanitize-text.js; do node "$t"; done
```

| Suite | Covers |
|---|---|
| `test-taste-routes.js` | Starting, streaming, reading and rerunning runs; ownership; rival discovery; the cache; featured briefs |
| `test-taste-brief.js` | Brief assembly: citation resolution, hotspots, the unsupported-trait backstop and refs in the narration |
| `test-taste-cache.js` | The brief cache, the per-visitor limits, friendly failure messages and the featured-brief script |
| `test-taste-share.js` | Share links, the public page and Send to Slack or Discord |
| `test-taste-privacy.js` | What can reach a model prompt |
| `test-qloo-rate.js` | Staying under Qloo's rate limit with several runs at once |
| `test-demo-login.js` | The demo account, the one-click sign-in and its limits (boots the real server) |
| `test-sanitize-text.js` | The dash and connector-plus post-processor |

The other `test-*.js` files belong to the original monitoring product. The `*-live` ones call real APIs.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/taste-cli.js` | Run one brief from the command line: `--brand`, `--rival` (repeatable), `--city`. |
| `scripts/generate-featured.js` | Write the featured briefs through the running server. |
| `scripts/qloo-discover.js` | Check rival discovery on the real Qloo API, with no model calls. |
| `scripts/qloo-smoke.js` | One call per Qloo endpoint, saving sample responses under the git-ignored `data/`. |
| `scripts/qloo-fake.js` | Synthetic Qloo answers, preloaded with `node -r` for offline work and tests. |
| `scripts/verify-workspace-integrity.js` | Database integrity check to run before a deploy. |

## The original monitoring product

Nivaria began as competitive intelligence for B2B sales teams, and that product still ships in this codebase. Leave `PRODUCT_MODE` unset to run it. It watches competitor web pages on a schedule (Playwright, with `ENABLE_SCRAPER` not set to `false`). It turns each meaningful change into a Claude-written brief with a threat level and talking points, and alerts Slack or Discord. It can push a briefing before calendar meetings that mention a tracked competitor, and it correlates win/loss deals with competitor activity. Its integrations (Google Calendar, Slack deal logging, Sign in with Google) are configured through the variables documented in `.env.example`.

There is no billing in either product. Every account is on one fixed plan, defined in `src/lib/tierLimits.js`.

## Built for the Qloo hackathon

Nivaria existed before the hackathon as the monitoring product above, and its last commit before the hackathon was on 3 August 2026. Everything Qloo-powered was built during the hackathon:

- The Qloo client, the agent tools and the provider-neutral agent with its model fallback chain
- Rival discovery, the live trace, and briefs with checked citations, the geo-gap map and the demographics chart
- The brief cache, the featured briefs, per-visitor limits, share links and Send to Slack or Discord
- The shared demo account and its one-click sign-in
- The new landing page, light and dark themes, and the cobalt brand and logo
- `PRODUCT_MODE=taste`, the droplet and Docker deployments, and the MIT license
- Billing was removed, so every account is on one fixed plan

## Security and data rights

See [SECURITY.md](SECURITY.md). Account data can be exported (`GET /api/account/export`) and deleted (`POST /api/account/delete`, with a 30-day grace period and a password check).

## License

[MIT](LICENSE). Built by Ediong Udotong.
