# Deploying Nivaria (Taste Gap) to the droplet

Step by step, over SSH, for a fresh Ubuntu droplet. Every command runs as root
on the droplet unless it says otherwise.

## 0. Before you start

- [ ] **DNS:** at your DNS provider, point an `A` record for `nivaria.app` and
      one for `www.nivaria.app` at the droplet's IPv4 address (and `AAAA`
      records if the droplet has IPv6). Caddy can only get HTTPS certificates
      once both names resolve to the droplet. Check from your own machine:

      ```
      dig +short nivaria.app
      dig +short www.nivaria.app
      ```

- [ ] **Resend:** the `nivaria.app` domain is verified in Resend, so mail can be
      sent from `noreply@nivaria.app`.
- [ ] **Keys at hand:** Qloo, Gemini, Groq, OpenRouter and Resend API keys, and
      the judge login email and password you will put on Devpost.

## 1. Log in and run the setup script

From your machine:

```
ssh root@YOUR_DROPLET_IP
```

On the droplet:

```
curl -fsSL https://raw.githubusercontent.com/UEddy/Nivaria/main/deploy/setup.sh -o setup.sh
bash setup.sh
```

It adds 1 GB of swap, installs Node 20 and Caddy, turns on the firewall (SSH,
80 and 443 only), creates the `nivaria` user, clones the repo to
`/opt/nivaria`, runs `npm ci --omit=dev`, and installs the systemd service and
the Caddyfile. It ends by saying `.env` does not exist yet. That is expected.

## 2. Create /opt/nivaria/.env

Make an empty file that only the app user can read:

```
install -m 600 -o nivaria -g nivaria /dev/null /opt/nivaria/.env
```

Generate a session secret and copy the output:

```
openssl rand -hex 32
```

Open the file:

```
nano /opt/nivaria/.env
```

Paste these lines and replace every placeholder with the real value:

```
APP_URL=https://nivaria.app
SESSION_SECRET=paste_the_openssl_rand_hex_32_output_here
QLOO_API_KEY=your_qloo_api_key
QLOO_BASE_URL=https://hackathon.api.qloo.com
LLM_CHAIN=gemini,gemini:gemini-3.5-flash,groq,openrouter
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
RESEND_API_KEY=your_resend_api_key
RESEND_FROM=Nivaria <noreply@nivaria.app>
DEMO_LOGIN_EMAIL=judge@nivaria.app
DEMO_LOGIN_PASSWORD=your_judge_password_at_least_12_characters
```

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

Notes:

- `RESEND_FROM` needs the angle brackets (`Name <address>`). Resend rejects the
  form without them.
- `DEMO_LOGIN_EMAIL` and `DEMO_LOGIN_PASSWORD` are the judge login. Without
  them there is no demo account. The password must be at least 12
  characters.
- Do **not** add `PRODUCT_MODE`, `ENABLE_SCRAPER`, `NODE_ENV` or `PORT`. The
  service sets them (`PRODUCT_MODE=taste`, `ENABLE_SCRAPER=false`,
  `NODE_ENV=production`, `PORT=3000`) and ignores any value here.
- Do **not** add `TASTE_EXAMPLES=refresh`. It regenerates the example briefs
  on every restart. See section 7 for the one time you might want it.

## 3. Start the service and watch the first boot

```
systemctl start nivaria
journalctl -u nivaria -f
```

On the first boot, with an empty database, look for:

- `✅ Demo login created for judge@nivaria.app`
- `[taste] generating example starbucks-dunkin-nyc`, then
  `[taste] example starbucks-dunkin-nyc ready (run 1)`
- the same pair for `glossier-fenty`

The two examples are real agent runs and take a few minutes in total. They
run in the background, so the site is already up while they generate. They
are generated once and kept in the database. Later boots never regenerate
them, and the demo account is only created when it is missing. If an example
fails (a provider rate limit, say), it is retried 10 minutes later, up to
three tries, and then at the next boot.

Press `Ctrl+C` to stop following the log. The service keeps running.

## 4. Check it from outside

From your machine:

```
curl -I https://nivaria.app
curl -I https://www.nivaria.app
```

The first should answer `200`. The second should answer `301` with
`location: https://nivaria.app/`. Then, in a browser (on your phone too):

- [ ] `https://nivaria.app` shows the Taste Gap landing page with a padlock.
- [ ] **Login** with the judge email and password signs in with no email code.
- [ ] The Taste Gap page shows the Starbucks vs Dunkin' featured example and
      the Glossier vs Fenty Beauty example (once section 3 shows both ready).
- [ ] Opening the featured example shows the map with OpenStreetMap tiles and
      the hotspots in New York City.
- [ ] A new run streams its trace and ends in a brief.

## 5. Logs and status

The app:

```
systemctl status nivaria                     # running? since when? memory use
journalctl -u nivaria -f                     # follow the live log
journalctl -u nivaria -n 200 --no-pager      # last 200 lines
journalctl -u nivaria --since "1 hour ago"   # a time window
```

Caddy (HTTPS and the proxy):

```
systemctl status caddy
journalctl -u caddy -f
journalctl -u caddy -n 100 --no-pager
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

The app directly, bypassing Caddy:

```
curl -s http://127.0.0.1:3000/health
```

Firewall:

```
ufw status verbose
```

## 6. Updating to the latest main

After pushing to `main` on GitHub:

```
bash /opt/nivaria/deploy/update.sh
```

It pulls, runs `npm ci --omit=dev`, installs the systemd unit or Caddyfile
again if the repo's copy changed, restarts the service, and waits for it to
answer. It prints `==> up:` and the current commit when it is done, or the
last 40 log lines if the app did not come back.

After editing `/opt/nivaria/.env`, restart to apply it:

```
systemctl restart nivaria
```

## 7. When something is wrong

- **`curl https://nivaria.app` fails, or the browser warns about the
  certificate:** DNS is not pointing at the droplet yet, or has not spread.
  `journalctl -u caddy -n 100 --no-pager` shows the certificate errors. Caddy
  keeps retrying, so once DNS is right it fixes itself.
- **`502 Bad Gateway`:** Caddy is up but the app is not. Check
  `systemctl status nivaria` and `journalctl -u nivaria -n 100 --no-pager`. A
  missing or default `SESSION_SECRET` stops the app at boot, with a message
  that says so.
- **The service restarts over and over and the log mentions memory:** it hit
  the 350 MB limit. `systemctl status nivaria` shows the memory peak.
- **No examples on the Taste Gap page:** look for `[taste]` lines in
  `journalctl -u nivaria`. `examples not generated: ...` names the missing
  key. To regenerate both once, add `TASTE_EXAMPLES=refresh` to `.env`, run
  `systemctl restart nivaria`, wait for both `ready` lines, then **remove the
  line** and restart again.
- **The judge login does not work:** check that both `DEMO_LOGIN_*` lines are
  in `.env`, that the password has at least 12 characters, and that the boot
  log has a `Demo login` line. A changed password takes effect at the next
  restart.

## 8. Backing up the database

Everything (accounts, runs, the examples) is in one file,
`/opt/nivaria/data/competitor-shadow.db`. Stop the app for a consistent copy:

```
systemctl stop nivaria
cp /opt/nivaria/data/competitor-shadow.db /root/nivaria-$(date +%F).db
systemctl start nivaria
```

From your machine, to download a backup:

```
scp root@YOUR_DROPLET_IP:/root/nivaria-YYYY-MM-DD.db .
```
