// Run the Taste Gap agent from the command line.
//
//   node scripts/taste-cli.js --brand Glossier --rival "Fenty Beauty" [--rival "Rare Beauty"] [--city "New York"]
//
// The model chain comes from LLM_CHAIN (see src/taste/llm.js); set it to one
// entry, e.g. LLM_CHAIN=zai, to run a single model. Streams each agent step as it
// happens, then prints the brief. The full run (brief, chart data, steps,
// usage) is written to data/taste-runs/, which is git-ignored: it holds Qloo
// response data, and that must not be committed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runTasteAgent } = require('../src/taste/agent');
const llm = require('../src/taste/llm');

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
  if (step.kind === 'switch') {
    if (step.status === 'done') console.log('[' + secs(step.at_ms) + '] !! ' + step.label + ' (' + step.summary + ')');
  } else if (step.kind === 'note') {
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
      else console.log('    - cell ' + e.geohash + ' (' + (e.label || e.neighborhood || e.area || 'unlabelled') + '): gap ' + pct(e.gap));
    }
  }

  console.log('\nWIN FIRST');
  for (const w of b.win_first) {
    console.log('\n  ' + w.rank + '. ' + w.segment);
    console.log('     Why: ' + w.why);
    console.log('     Hook: ' + w.campaign_hook);
    console.log('     Channels: ' + (w.channels || []).join('; '));
    console.log('     Evidence: ' + w.evidence.map(e => e.kind === 'entity' ? e.name + ' (gap ' + pct(e.gap) + ')' : (e.label || e.neighborhood || e.area || e.geohash) + ' (gap ' + pct(e.gap) + ')').join(', '));
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
  let chain;
  try {
    chain = llm.buildChain();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log('Taste Gap: ' + args.brand + ' vs ' + args.rivals.join(', ') + (args.city ? ' in ' + args.city : '')
    + '\nModel chain: ' + chain.map(e => e.key).join(' > ') + '\n');

  let run;
  try {
    run = await runTasteAgent({ ...args, onStep: printStep });
  } catch (err) {
    console.error('\nRun failed: ' + err.message + (err.steps ? ' after ' + err.steps.length + ' steps' : ''));
    process.exit(1);
  }

  printBrief(run);

  const toolSteps = run.steps.filter(s => s.kind === 'tool');
  console.log('\n' + '-'.repeat(78));
  console.log(run.turns + ' turns, ' + toolSteps.length + ' tool calls, ' + secs(run.duration_ms));
  for (const p of run.providers) {
    console.log('  ' + p.provider + ' ' + p.model + ': ' + p.turns + ' turns, tokens in ' + p.usage.input_tokens
      + ', out ' + p.usage.output_tokens + ', cache read ' + p.usage.cache_read_input_tokens);
  }
  if (run.warnings.length) console.log('Warnings: ' + run.warnings.join('; '));

  const dir = path.join(__dirname, '..', 'data', 'taste-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  console.log('Full run saved to ' + path.relative(path.join(__dirname, '..'), file));
}

main();
