// Taste Gap sharing: public read-only links, and sending a brief to Slack or
// Discord.
//
//   node test-taste-share.js
//
// Runs the real /api/taste router, the public share routes, the settings
// router and the run store on a throwaway database, with the scripted model
// stand-in and the fake Qloo, so it needs no keys. Outbound webhook posts are
// captured instead of sent. Each "browser" keeps its own session cookie, which
// is how two judges on the shared demo account are told apart.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-share-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.db');
process.env.LLM_CHAIN = 'scripted';
process.env.SCRIPTED_DELAY_MS = '20';
process.env.TASTE_FRESH_PER_DAY = '100';
process.env.DEMO_LOGIN_EMAIL = 'judge@example.test';
process.env.APP_URL = 'https://nivaria.example';
require('./scripts/qloo-fake');

// Capture webhook posts. failNext makes the next one fail like a dead webhook.
const axios = require('axios');
const posts = [];
let failNext = false;
axios.post = async (url, body) => {
  if (failNext) { failNext = false; throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }); }
  posts.push({ url, body });
  return { status: 200, data: 'ok' };
};

const express = require('express');
const session = require('express-session');
const { initDb, getDb } = require('./src/db');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('  ok   ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const ME = 9201;
const OTHER = 9202;
const JUDGE = 9203;
const EMAIL = { [ME]: 'me@example.test', [OTHER]: 'other@example.test', [JUDGE]: 'judge@example.test' };

// A browser: a user and a cookie jar.
function browser(user) {
  const jar = { cookie: null };
  return {
    user,
    req(port, method, url, body) {
      return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json', 'x-test-user': String(user || '') };
        if (jar.cookie) headers.Cookie = jar.cookie;
        const r = http.request({ port, method, path: url, headers }, res => {
          const set = res.headers['set-cookie'];
          if (set) jar.cookie = set.map(c => c.split(';')[0]).join('; ');
          let text = '';
          res.on('data', c => { text += c; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(text); } catch (_) {}
            resolve({ status: res.statusCode, headers: res.headers, text, json });
          });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
      });
    },
  };
}

async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

const DASH = /[\u2013\u2014]/;

async function main() {
  await initDb();
  const db = getDb();
  for (const id of [ME, OTHER, JUDGE]) {
    db.prepare("INSERT INTO users (id, email, name, api_key) VALUES (?, ?, 'Test', ?)").run(id, EMAIL[id], 'key' + id);
  }
  const runs = require('./src/tasteRuns');

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use(require('./src/routes/tasteShare'));
  app.use((req, _res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (id) { req.userId = id; req.user = { id, email: EMAIL[id] }; }
    next();
  });
  app.use('/api/taste', require('./src/routes/taste'));
  app.use('/api/settings', require('./src/routes/settings'));
  const server = app.listen(0);
  const port = server.address().port;

  const me = browser(ME);
  const other = browser(OTHER);
  const visitor = browser(null);

  // A finished brief with a city (map and chart), and one still running.
  const start = await me.req(port, 'POST', '/api/taste/runs', { brand: 'Starbucks', rivals: ["Dunkin' Donuts"], city: 'New York' });
  const runId = start.json.run.id;
  const run = await waitFor(async () => { const r = await me.req(port, 'GET', '/api/taste/runs/' + runId); return r.json.run.status === 'done' && r.json.run; });

  console.log('share links');
  const none = await me.req(port, 'GET', '/api/taste/runs/' + runId + '/share');
  check('a brief has no link until one is made', none.status === 200 && none.json.share === null, none.text);
  const made = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/share');
  const link = made.json.share;
  check('Share makes a link under APP_URL with a long random token', made.status === 200 && /^https:\/\/nivaria\.example\/share\/[A-Za-z0-9_-]{32}$/.test(link.url), made.text);
  const again = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/share');
  check('asking again returns the same link', again.json.share.token === link.token);
  const otherSees = await other.req(port, 'GET', '/api/taste/runs/' + runId + '/share');
  check("another account cannot reach the owner's brief or link", otherSees.status === 404);

  console.log('the public page');
  const pageRes = await visitor.req(port, 'GET', '/share/' + link.token);
  check('the page opens logged out', pageRes.status === 200 && /<main class="share-main"/.test(pageRes.text));
  check('it is noindex in the header and the page', /noindex/.test(pageRes.headers['x-robots-tag'] || '') && /<meta name="robots" content="noindex/.test(pageRes.text));
  check('it is never cached and sends no Referer', pageRes.headers['cache-control'] === 'no-store' && pageRes.headers['referrer-policy'] === 'no-referrer');
  const ogTitle = (/<meta property="og:title" content="([^"]*)"/.exec(pageRes.text) || [])[1] || '';
  check('the link preview names the pair, with the apostrophe escaped', ogTitle.includes('Starbucks vs Dunkin&#39; Donuts in New York'), ogTitle);
  check('and carries the headline as its description', pageRes.text.includes('content="' + run.brief.headline.replace(/'/g, '&#39;') + '"'));
  check('with the Made with Nivaria footer and a Get started link', /Made with Nivaria · powered by Qloo/.test(pageRes.text) && /href="\/register"[^>]*>Get started/.test(pageRes.text));
  check('the og image is absolute', /og:image" content="https:\/\/nivaria\.example\/assets\/og-image\.png"/.test(pageRes.text));

  const data = await visitor.req(port, 'GET', '/api/share/' + link.token);
  const pub = data.json?.run || {};
  check('its data loads logged out, with the brief, map and chart', data.status === 200 && Boolean(pub.brief?.headline)
    && Object.keys(pub.data?.geo || {}).length > 0 && Object.keys(pub.data?.demographics || {}).length > 0, data.text.slice(0, 120));
  const allowed = ['status', 'brand', 'rivals', 'city', 'created_at', 'finished_at', 'brief', 'data'];
  check('and nothing private: no trace, model, notes, owner or ids', Object.keys(pub).every(k => allowed.includes(k)), Object.keys(pub).join(','));
  check('the data is noindex and never cached too', /noindex/.test(data.headers['x-robots-tag'] || '') && data.headers['cache-control'] === 'no-store');

  const bogus = await visitor.req(port, 'GET', '/api/share/not-a-real-token-at-all-xyz');
  const bogusPage = await visitor.req(port, 'GET', '/share/not-a-real-token-at-all-xyz');
  check('an unknown token is a 404 that still renders the page', bogus.status === 404 && bogusPage.status === 404 && /Brief not available/.test(bogusPage.text));
  const odd = await visitor.req(port, 'GET', '/share/' + encodeURIComponent('<script>'));
  check('a malformed token is refused without echoing it', odd.status === 404 && !odd.text.includes('<script>alert'));

  console.log('revoking');
  const otherRevoke = await other.req(port, 'DELETE', '/api/taste/runs/' + runId + '/share');
  check('another account cannot revoke it', otherRevoke.status === 404 && (await visitor.req(port, 'GET', '/api/share/' + link.token)).status === 200);
  const revoke = await me.req(port, 'DELETE', '/api/taste/runs/' + runId + '/share');
  check('the owner can revoke it', revoke.status === 200 && revoke.json.revoked === true);
  const gone = await visitor.req(port, 'GET', '/api/share/' + link.token);
  const gonePage = await visitor.req(port, 'GET', '/share/' + link.token);
  check('a revoked link stops working at once', gone.status === 404 && gonePage.status === 404 && /no longer available/.test(gonePage.text));
  const fresh = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/share');
  check('a new link after revoking has a new token', fresh.json.share.token !== link.token
    && (await visitor.req(port, 'GET', '/api/share/' + fresh.json.share.token)).status === 200);

  const running = await me.req(port, 'POST', '/api/taste/runs', { brand: 'Nike', rivals: ['Adidas'], fresh: true });
  const notDone = await me.req(port, 'POST', '/api/taste/runs/' + running.json.run.id + '/share');
  check('a brief still running cannot be shared', notDone.status === 409, notDone.text);
  await waitFor(async () => (await me.req(port, 'GET', '/api/taste/runs/' + running.json.run.id)).json.run.status !== 'running');

  console.log('featured briefs');
  const feat = await runs.runExample('glossier-fenty', { brand: 'Glossier', rivals: ['Fenty Beauty'], city: null });
  const featLink = (await other.req(port, 'POST', '/api/taste/runs/' + feat.id + '/share')).json.share;
  check('any account can share a featured brief', Boolean(featLink?.token));
  const rewritten = await runs.runExample('glossier-fenty', { brand: 'Glossier', rivals: ['Fenty Beauty'], city: null });
  const follow = await visitor.req(port, 'GET', '/api/share/' + featLink.token);
  check('when the featured brief is rewritten, its link follows the new one', rewritten.id !== feat.id && follow.status === 200
    && db.prepare('SELECT run_id FROM taste_shares WHERE token = ?').get(featLink.token).run_id === rewritten.id);

  console.log('send to Slack or Discord');
  const noHook = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/send');
  check('with no webhook saved, send asks for one', noHook.status === 409 && noHook.json.code === 'no_webhook', noHook.text);
  const badHook = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/send', { webhook: 'https://example.com/hook' });
  check('a webhook that is not Slack or Discord is refused', badHook.status === 400 && badHook.json.code === 'bad_webhook' && posts.length === 0, badHook.text);

  const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
  const sent = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/send', { webhook: SLACK });
  check('a pasted Slack webhook is saved and the brief goes out', sent.status === 200 && sent.json.sent.join() === 'slack' && posts.length === 1 && posts[0].url === SLACK, sent.text);
  check('it is saved where the Integrations card reads it', db.prepare('SELECT slack_webhook FROM settings WHERE user_id = ?').get(ME)?.slack_webhook === SLACK);
  const slackText = JSON.stringify(posts[0].body);
  const picks = run.brief.win_first.slice(0, 3);
  check('the Slack message has the headline', slackText.includes(run.brief.headline.replace(/&/g, '&amp;')));
  check('and the top three win-first picks with their Qloo numbers', picks.every(w => slackText.includes(w.rank + '. ')) && /Qloo: [^"]+\(Dunkin' Donuts \d+, Starbucks \d+, gap -?\d+\)/.test(slackText), slackText.slice(0, 400));
  check('and the share link, which works logged out', slackText.includes(sent.json.share.url)
    && (await visitor.req(port, 'GET', '/api/share/' + sent.json.share.token)).status === 200);
  check('with the Made with Nivaria credit and no dashes', /Made with Nivaria · powered by Qloo/.test(slackText) && !DASH.test(slackText));

  const DISCORD = 'https://discord.com/api/webhooks/123/abc';
  const both = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/send', { webhook: DISCORD });
  check('with Slack and Discord saved, both get it', both.json.sent.sort().join() === 'discord,slack' && posts.length === 3, both.text);
  const discord = posts.find(p => p.url === DISCORD).body;
  check('the Discord message is an embed with the picks and the link', discord.embeds[0].url === both.json.share.url
    && discord.embeds[0].fields.length === Math.min(3, run.brief.win_first.length) && discord.content.includes(both.json.share.url) && !DASH.test(JSON.stringify(discord)));
  check('sending reuses the one share link', both.json.share.token === sent.json.share.token);

  failNext = true;
  const partial = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/send');
  check('when one webhook fails, the other still sends and the failure is named', partial.status === 200 && partial.json.sent.length === 1 && partial.json.failed.length === 1, partial.text);
  db.prepare('UPDATE settings SET discord_webhook = NULL WHERE user_id = ?').run(ME);
  failNext = true;
  const dead = await me.req(port, 'POST', '/api/taste/runs/' + runId + '/send');
  check('when every webhook fails, the message is friendly', dead.status === 502 && dead.json.code === 'send_failed'
    && /did not accept the message\. Check the webhook in Profile, Integrations/.test(dead.json.error) && !/404|status code/.test(dead.json.error), dead.text);

  console.log('the shared demo account');
  const judgeA = browser(JUDGE);
  const judgeB = browser(JUDGE);
  await judgeA.req(port, 'GET', '/api/settings');
  await judgeB.req(port, 'GET', '/api/settings');
  const jRun = await runs.runExample('nike-adidas-la', { brand: 'Nike', rivals: ['Adidas'], city: 'Los Angeles' });
  const aLink = (await judgeA.req(port, 'POST', '/api/taste/runs/' + jRun.id + '/share')).json.share;
  const bSees = (await judgeB.req(port, 'GET', '/api/taste/runs/' + jRun.id + '/share')).json.share;
  check("one judge does not see another judge's link", Boolean(aLink?.token) && bSees === null);
  const bRevoke = await judgeB.req(port, 'DELETE', '/api/taste/runs/' + jRun.id + '/share');
  check("or revoke it", bRevoke.json.revoked === false && (await visitor.req(port, 'GET', '/api/share/' + aLink.token)).status === 200);

  const JUDGE_HOOK = 'https://hooks.slack.com/services/TJ/BJ/judge';
  const jSent = await judgeA.req(port, 'POST', '/api/taste/runs/' + jRun.id + '/send', { webhook: JUDGE_HOOK });
  check('a judge can send with a pasted webhook', jSent.status === 200 && posts[posts.length - 1].url === JUDGE_HOOK, jSent.text);
  const aSettings = (await judgeA.req(port, 'GET', '/api/settings')).json.settings;
  const bSettings = (await judgeB.req(port, 'GET', '/api/settings')).json.settings;
  check('the webhook shows on that judge\'s Integrations card', aSettings.slack_webhook === JUDGE_HOOK);
  check('but not on another judge\'s', !bSettings.slack_webhook);
  check('and never lands on the shared settings row', !db.prepare('SELECT slack_webhook FROM settings WHERE user_id = ?').get(JUDGE)?.slack_webhook);
  const bNoHook = await judgeB.req(port, 'POST', '/api/taste/runs/' + jRun.id + '/send');
  check('so another judge is asked for their own', bNoHook.status === 409 && bNoHook.json.code === 'no_webhook' && bNoHook.json.session_only === true);
  const put = await judgeB.req(port, 'PUT', '/api/settings', { slack_webhook: 'https://hooks.slack.com/services/TB/BB/other' });
  const aAfter = (await judgeA.req(port, 'GET', '/api/settings')).json.settings;
  check('saving on the Integrations card stays in that judge\'s session too', put.status === 200 && aAfter.slack_webhook === JUDGE_HOOK
    && !db.prepare('SELECT slack_webhook FROM settings WHERE user_id = ?').get(JUDGE)?.slack_webhook);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
