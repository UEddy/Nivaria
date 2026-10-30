// Write the featured Taste Gap briefs with the model chain, one at a time.
//
//   cd /opt/nivaria && sudo -u nivaria node scripts/generate-featured.js
//
// Each brief goes through the chain in its usual order (LLM_CHAIN, else the
// default chain), falling back down it as a live run does.
//
// Options:
//   --provider name   only that provider's models from the chain (baseten,
//                     gemini for both Gemini models, groq, openrouter...)
//   --force           rewrite pairs that already have a current brief
//   --only a,b        just these pair keys (see src/tasteFeatured.js)
//   --pause 20        seconds to wait between briefs (default 20), to stay
//                     under Gemini's per-minute limit
//   --base URL        the server (default http://127.0.0.1:$PORT, PORT 3000)
//
// Run it on the server while the service is up. The running server does the
// work (POST /internal/taste/featured/:key): sql.js keeps the database in the
// server's memory, so a second process writing the file would be overwritten,
// and this way every Qloo call goes through the server's one rate limiter.
// The internal token comes from SESSION_SECRET in .env, which is why it runs
// as the service user from the app directory.
//
// It skips pairs that already have a current brief, stops cleanly when every
// model in the chain is out of quota or credit, and can be run again to
// resume. The two original examples are rewritten too: they were not written
// by this script.
//
// Exit code: 0 when every pair is ready, 2 when it stopped early because the
// chain is out of quota or credit, 1 for anything else (server down, a failed
// pair, an unknown provider).

const http = require('http');
const https = require('https');
const { internalToken } = require('../src/lib/internalToken');

const RUN_TIMEOUT_MS = 6 * 60 * 1000;

function parseArgs(argv) {
  const out = { force: false, only: null, provider: null, pauseMs: 20000, base: 'http://127.0.0.1:' + (process.env.PORT || 3000) };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--force') out.force = true;
    else if (k === '--provider') {
      out.provider = String(argv[++i] || '').trim().toLowerCase();
      if (!out.provider) throw new Error('--provider needs a provider name, such as baseten or gemini');
    }
    else if (k === '--only') out.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--pause') out.pauseMs = Math.max(0, Number(argv[++i]) || 0) * 1000;
    else if (k === '--base') out.base = String(argv[++i] || '').replace(/\/+$/, '');
    else throw new Error('Unknown option ' + k);
  }
  return out;
}

function call(base, method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method,
      headers: { 'x-internal-token': internalToken('taste-featured'), Accept: 'application/json' },
      timeout: RUN_TIMEOUT_MS,
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('the server answered ' + res.statusCode + (res.statusCode === 404 ? ' (wrong SESSION_SECRET, or not a local request?)' : '')));
        try { resolve(JSON.parse(text)); } catch (_) { reject(new Error('the server sent something that is not JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('no answer within ' + RUN_TIMEOUT_MS / 60000 + ' minutes')));
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const secs = ms => (ms == null ? '' : Math.round(ms / 1000) + 's');

async function main(argv = process.argv.slice(2), log = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(err.message);
    return 1;
  }

  const providerQuery = opts.provider ? 'provider=' + encodeURIComponent(opts.provider) : '';
  let pairs;
  let chain;
  try {
    const status = await call(opts.base, 'GET', '/internal/taste/featured' + (providerQuery ? '?' + providerQuery : ''));
    if (status.error) { log('Cannot write featured briefs: ' + status.error); return 1; }
    ({ pairs, chain } = status);
  } catch (err) {
    log('Could not reach the server at ' + opts.base + ': ' + err.message + '. Is the service running?');
    return 1;
  }
  if (opts.only) {
    const unknown = opts.only.filter(k => !pairs.some(p => p.key === k));
    if (unknown.length) { log('No featured pair with key ' + unknown.join(', ')); return 1; }
    pairs = pairs.filter(p => opts.only.includes(p.key));
  }

  log('Featured briefs on ' + opts.base + ', one at a time with ' + (chain || []).join(' > ') + (opts.force ? ', rewriting current ones' : ''));
  let ready = 0;
  let failed = 0;
  let wrote = false;
  for (const [i, p] of pairs.entries()) {
    const n = (i + 1) + '/' + pairs.length + ' ' + p.label;
    if (p.status === 'current' && !opts.force) {
      log('  ' + n + ': already current, skipped');
      ready += 1;
      continue;
    }
    if (wrote && opts.pauseMs) await sleep(opts.pauseMs);
    wrote = true;
    log('  ' + n + ': writing (' + (p.status === 'stale' ? 'replacing the older brief' : 'new') + ')...');
    let r;
    try {
      const query = [opts.force ? 'force=1' : '', providerQuery].filter(Boolean).join('&');
      r = await call(opts.base, 'POST', '/internal/taste/featured/' + encodeURIComponent(p.key) + (query ? '?' + query : ''));
    } catch (err) {
      log('    could not finish: ' + err.message + '. Run this again to resume.');
      return 1;
    }
    if (r.result === 'done' || r.result === 'skipped') {
      ready += 1;
      log('    ' + (r.result === 'done' ? 'done in ' + secs(r.ms) + ' (' + r.model + ')' : 'already current') + ': ' + r.headline);
    } else if (r.result === 'quota') {
      log('    Every model in the chain is out of quota or credit (' + (r.error || '429') + ').');
      log('Stopped with ' + ready + ' of ' + pairs.length + ' ready. Run this again after the quota resets to write the rest.');
      return 2;
    } else if (r.result === 'busy') {
      log('    the server is already writing a featured brief. Wait for it, then run this again.');
      return 1;
    } else {
      failed += 1;
      log('    failed: ' + (r.error || r.result) + '. Moving on; run this again to retry it.');
    }
  }
  log(ready + ' of ' + pairs.length + ' featured briefs ready' + (failed ? ', ' + failed + ' failed' : '') + '.');
  return ready === pairs.length ? 0 : 1;
}

if (require.main === module) {
  require('dotenv').config();
  main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}

module.exports = { main, parseArgs };
