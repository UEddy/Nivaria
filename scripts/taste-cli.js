// Run the Taste Gap agent from the command line.
//
//   node scripts/taste-cli.js --brand Glossier --rival "Fenty Beauty" [--rival "Rare Beauty"] [--city "New York"]
//
// Streams each agent step as it happens, then prints the brief. The full run
// (brief, chart data, steps, usage) is written to data/taste-runs/, which is
// git-ignored: it holds Qloo response data, and that must not be committed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runTasteAgent, MODEL } = require('../src/taste/agent');

// Sonnet 4.6 list prices per million tokens, for a rough cost line.
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

function parseArgs(argv) {
  const out = { rivals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--brand') { out.brand = v; i += 1; }
    else if (k === '--rival') { out.rivals.push(v); i += 1; }
    else if (k === '--city') { out.city = v; i += 1; }
  }
  return out;
}

const secs = ms => (ms / 1000).toFixed(1) + 's';
const pct = x => (x == null ? 'n/a' : Math.round(x * 100));

function printStep(step) {
  if (step.kind === 'note') {
    console.log('[' + secs(step.at_ms) + ']   (agent) ' + step.label);
  } else if (step.status === 'running') {
    console.log('[' + secs(step.at_ms) + '] > ' + step.label);
  } else {
    const mark = step.status === 'done' ? 'ok ' : 'ERR';
    console.log('          ' + mark + ' ' + step.label + ' (' + secs(step.ms) + '): ' + (step.summary || ''));
  }
}

function printBrief(run) {
  const b = run.brief;
  const name = id => (b.rivals.find(r => r.entity_id === id) || {}).name || id;
  console.log('\n' + '='.repeat(78));
  console.log(b.headline);
  console.log('='.repeat(78));
  console.log(b.summary);

  console.log('\nRIVAL-OWNED SEGMENTS');
  for (const s of b.rival_owned_segments) {
    console.log('\n  ' + s.segment + '  [' + s.domain + ', ' + name(s.rival_id) + ', confidence ' + s.confidence + ']');
    console.log('  ' + s.insight);
    for (const e of s.evidence) {
      if (e.kind === 'entity') console.log('    - ' + e.name + ': rival ' + pct(e.rival_affinity) + ', us ' + pct(e.our_affinity) + ', gap ' + pct(e.gap));
      else console.log('    - cell ' + e.geohash + ' (' + (e.neighborhood || 'unlabelled') + '): gap ' + pct(e.gap));
    }
  }

  console.log('\nWIN FIRST');
  for (const w of b.win_first) {
    console.log('\n  ' + w.rank + '. ' + w.segment);
    console.log('     Why: ' + w.why);
    console.log('     Hook: ' + w.campaign_hook);
    console.log('     Channels: ' + (w.channels || []).join('; '));
    console.log('     Evidence: ' + w.evidence.map(e => e.kind === 'entity' ? e.name + ' (gap ' + pct(e.gap) + ')' : (e.neighborhood || e.geohash) + ' (gap ' + pct(e.gap) + ')').join(', '));
  }

  if (b.geo_hotspots.length) {
    console.log('\nGEO HOTSPOTS');
    for (const h of b.geo_hotspots) {
      console.log('  ' + h.label + ' [' + h.geohash + ' ' + h.lat.toFixed(4) + ',' + h.lng.toFixed(4) + '] rival ' + pct(h.rival_affinity) + ' vs us ' + pct(h.our_affinity) + ': ' + h.note);
    }
  }
  for (const d of b.demographic_gap) console.log('\nDEMOGRAPHICS (' + name(d.rival_id) + '): ' + d.summary);
  for (const p of b.positioning) console.log('\nPOSITIONING (' + name(p.rival_id) + '): ' + p.summary);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.brand || !args.rivals.length) {
    console.error('Usage: node scripts/taste-cli.js --brand <name> --rival <name> [--rival <name>] [--city <name>]');
    process.exit(1);
  }
  console.log('Taste Gap: ' + args.brand + ' vs ' + args.rivals.join(', ') + (args.city ? ' in ' + args.city : '') + ' (' + MODEL + ')\n');

  let run;
  try {
    run = await runTasteAgent({ ...args, onStep: printStep });
  } catch (err) {
    console.error('\nRun failed: ' + err.message + (err.steps ? ' after ' + err.steps.length + ' steps' : ''));
    process.exit(1);
  }

  printBrief(run);

  const u = run.usage;
  const cost = (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output
    + u.cache_creation_input_tokens * PRICE.cacheWrite + u.cache_read_input_tokens * PRICE.cacheRead) / 1e6;
  const toolSteps = run.steps.filter(s => s.kind === 'tool');
  console.log('\n' + '-'.repeat(78));
  console.log(run.turns + ' turns, ' + toolSteps.length + ' tool calls, ' + secs(run.duration_ms)
    + '; tokens in ' + u.input_tokens + ', out ' + u.output_tokens + ', cache write ' + u.cache_creation_input_tokens
    + ', cache read ' + u.cache_read_input_tokens + ' (about $' + cost.toFixed(3) + ')');
  if (run.warnings.length) console.log('Warnings: ' + run.warnings.join('; '));

  const dir = path.join(__dirname, '..', 'data', 'taste-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  console.log('Full run saved to ' + path.relative(path.join(__dirname, '..'), file));
}

main();
