// Privacy checks for the Taste Gap agent: no user account data may reach a
// model prompt (prompts go to third-party APIs, some on free tiers that may
// keep them). Three layers:
//   1. Imports: every module under src/taste and src/qloo may only require
//      from an allowlist, so none can reach the database, session or account
//      modules.
//   2. Inputs: cleanInput strips emails, phone numbers and control characters
//      from the typed brand, rival and city, and leaves real names alone.
//   3. Requests: a run handed account-shaped extras is captured at the
//      provider boundary, and nothing but the system prompt and the three
//      typed strings is in it.
// No network: the provider is stubbed and the run stops at the first model
// call. Run with `node test-taste-privacy.js`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); console.log(`✅ ${label}`); pass++; }
  catch (e) { console.log(`❌ ${label}\n     ${e.message}`); fail++; }
}

// ── 1. Imports ────────────────────────────────────────────────────────────────
const ALLOWED_REQUIRES = new Set([
  'axios', '@anthropic-ai/sdk',
  '../lib/retry', '../lib/sanitizeText',
  './client', './llm', '../qloo/tools',
]);
for (const dir of ['src/taste', 'src/qloo']) {
  for (const file of fs.readdirSync(path.join(__dirname, dir)).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(__dirname, dir, file), 'utf8');
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    check(`${dir}/${file} only requires allowlisted modules`, () => {
      const bad = requires.filter(r => !ALLOWED_REQUIRES.has(r));
      assert.deepStrictEqual(bad, [], 'unexpected require: ' + bad.join(', '));
    });
  }
}

// ── 2. Inputs ─────────────────────────────────────────────────────────────────
const agent = require('./src/taste/agent');
const { cleanInput } = agent;
const eq = (input, expected, label) => check(label, () => assert.strictEqual(cleanInput(input), expected));
eq('Glossier jane.doe@example.com', 'Glossier', 'email address removed');
eq('Fenty Beauty +1 (415) 555-0134', 'Fenty Beauty', 'phone number removed');
eq('New\nYork\u0000', 'New York', 'control characters removed');
eq('x'.repeat(200), 'x'.repeat(80), 'capped at 80 characters');
eq("Dunkin'", "Dunkin'", 'apostrophe kept');
eq('7-Eleven', '7-Eleven', 'short digit run kept');
eq('Forever 21', 'Forever 21', 'trailing number kept');
eq("Ben & Jerry's", "Ben & Jerry's", 'ampersand kept');

// ── 3. Requests ───────────────────────────────────────────────────────────────
const llm = require('./src/taste/llm');
const DECOYS = ['jane.doe@example.com', 'Jane Doe', 'ws_secret_42', 'Acme Payroll SaaS', 'user-9917'];
let captured = null;
llm.buildChain = () => [{ name: 'stub', model: 'stub', key: 'stub:stub' }];
llm.createProvider = entry => ({
  ...entry, label: 'Stub', timeoutMs: 1000, inputBudget: 0,
  async complete(request) {
    captured = JSON.stringify({ system: request.system, transcript: request.transcript, tools: request.tools });
    throw Object.assign(new Error('stop after capture'), { status: 400 });
  },
});

(async () => {
  await agent.runTasteAgent({
    brand: 'Glossier jane.doe@example.com',
    rivals: ['Fenty Beauty'],
    city: 'New York',
    // Account-shaped extras a careless caller might pass. They must be ignored.
    user: { id: 'user-9917', name: 'Jane Doe', email: 'jane.doe@example.com' },
    workspace: { id: 'ws_secret_42', business_context: 'Acme Payroll SaaS' },
  }).catch(() => {});

  check('the stubbed provider received a request', () => assert.ok(captured));
  for (const d of DECOYS) {
    check(`request does not contain "${d}"`, () => assert.ok(!captured.includes(d)));
  }
  const req = JSON.parse(captured);
  check('system prompt is the fixed SYSTEM_PROMPT', () => assert.strictEqual(req.system, agent.SYSTEM_PROMPT));
  check('transcript is one user message', () => {
    assert.strictEqual(req.transcript.length, 1);
    assert.strictEqual(req.transcript[0].role, 'user');
  });
  check('that message is exactly the brand, rival and city lines', () => {
    assert.strictEqual(req.transcript[0].text, agent.userPrompt('Glossier', ['Fenty Beauty'], 'New York'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
