# Foresight

**AI-powered competitive intelligence monitoring platform.**

Foresight watches your rivals' websites and uses Claude AI to analyze what changed, why it matters, and what your sales team should do about it — then delivers battle cards straight to Slack or Discord.

---

## Features

- **Automatic monitoring** — checks competitor pages every 24 hours (Pro/Team)
- **AI analysis** — Claude AI explains what changed, scores the threat level (low/medium/high), and writes talking points
- **Battle cards** — structured competitive reports with recommended response and sales talking points
- **Slack & Discord alerts** — instant webhook notifications when changes are detected
- **Tier enforcement** — Free (1 URL), Pro (10 URLs, $20/mo), Team (unlimited, $49/mo)
- **Stripe-ready** — payment integration is stubbed out, drop in your keys to activate

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url>
cd competitor-shadow
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add at minimum:

```env
ANTHROPIC_API_KEY=sk-ant-...     # Required for AI analysis
PORT=3000                         # Optional, defaults to 3000
```

### 3. Run the app

```bash
# Development (auto-restarts on changes)
npm run dev

# Production
npm start
```

Open **http://localhost:3000** — demo data is seeded automatically on first run.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes* | Claude AI API key for change analysis |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to `production` for prod mode |
| `APP_URL` | No | Public URL for webhook links (default: http://localhost:3000) |
| `STRIPE_SECRET_KEY` | No | Stripe secret key to enable payments |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | No | Stripe Price ID for Pro plan |
| `STRIPE_TEAM_PRICE_ID` | No | Stripe Price ID for Team plan |

*Without `ANTHROPIC_API_KEY`, changes are still detected but analysis falls back to a basic automated summary.

---

## API Endpoints

All endpoints accept/return JSON.

### Competitors
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/competitors` | List all competitors |
| `POST` | `/api/competitors` | Add a competitor `{ name, url, description? }` |
| `DELETE` | `/api/competitors/:id` | Delete a competitor |
| `PUT` | `/api/competitors/:id/toggle` | Pause/resume monitoring |
| `POST` | `/api/competitors/:id/check` | Trigger an immediate check |

### Changes
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/changes` | List changes (supports `?threat=high&page=1&limit=20`) |
| `GET` | `/api/changes/:id` | Get a single change with full battle card |
| `GET` | `/api/changes/stats` | Dashboard stats |

### Settings
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/settings` | Get settings + user info |
| `PUT` | `/api/settings` | Update `{ slack_webhook, discord_webhook }` |
| `POST` | `/api/settings/test-webhook` | Test webhook `{ type: "slack"|"discord", url }` |

---

## Tier Limits

| Feature | Free | Pro ($20/mo) | Team ($49/mo) |
|---|---|---|---|
| Competitor URLs | 1 | 10 | Unlimited |
| Automatic daily checks | ✗ | ✓ | ✓ |
| Slack / Discord alerts | ✗ | ✓ | ✓ |
| AI battle cards | ✓ | ✓ | ✓ |
| Multiple webhooks | ✗ | ✗ | ✓ |

Use the **Settings → Demo Controls** section to switch tiers and observe enforcement.

---

## Enabling Stripe Payments

1. Install Stripe: `npm install stripe`
2. Add your keys to `.env`
3. Create products/prices in the Stripe dashboard
4. Set `STRIPE_PRO_PRICE_ID` and `STRIPE_TEAM_PRICE_ID`
5. Uncomment the Stripe code in `src/payments.js`
6. Point your Stripe webhook to `POST /api/stripe/webhook`

---

## Project Structure

```
competitor-shadow/
├── src/
│   ├── server.js         Express app + auth middleware
│   ├── db.js             SQLite schema + demo seeding
│   ├── scraper.js        Page fetching + diff generation
│   ├── analyzer.js       Claude AI integration
│   ├── webhooks.js       Slack + Discord alerts
│   ├── payments.js       Stripe placeholder
│   ├── scheduler.js      24-hour cron job
│   └── routes/
│       ├── auth.js
│       ├── competitors.js
│       ├── changes.js
│       └── settings.js
├── public/
│   ├── index.html        SPA shell
│   ├── css/styles.css    Dark theme UI
│   └── js/
│       ├── app.js        Router + utilities
│       ├── api.js        Fetch client
│       ├── dashboard.js
│       ├── competitors.js
│       ├── history.js
│       ├── battlecard.js
│       └── settings.js
├── data/                 SQLite database (auto-created, gitignored)
├── .env.example
└── package.json
```

---

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite via sql.js (pure WASM — no native compilation required)
- **AI**: Anthropic Claude (claude-sonnet-4-6)
- **Scraping**: axios + cheerio
- **Scheduler**: node-cron
- **Frontend**: Vanilla JS SPA, Inter font, dark theme
- **Payments**: Stripe (placeholder)

---

## License

MIT
