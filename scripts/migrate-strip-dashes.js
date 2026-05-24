// One-shot data migration: strip em-dashes (— U+2014) and en-dashes (– U+2013)
// from historical AI- and system-generated text already stored in the database.
//
// Scope (rendered to users):
//   changes.headline                       (plain TEXT)
//   changes.recommended_response           (plain TEXT)
//   changes.historical_context             (plain TEXT)
//   changes.gate_reason                    (plain TEXT)
//   changes.analysis_error                 (plain TEXT)
//   changes.analysis                       (JSON, walked recursively)
//   changes.talking_points                 (JSON array, walked recursively)
//   generated_playbooks.subject_line       (plain TEXT)
//   generated_playbooks.body               (plain TEXT)
//   generated_playbooks.generation_error   (plain TEXT)
//   competitors.last_check_error           (plain TEXT, system-generated)
//   tracked_meetings.briefing_error        (plain TEXT, system-generated)
//
// Not touched (user-supplied, must be preserved verbatim):
//   user_context.*                        (user's business context text)
//   user_voice_profile.*                  (voice_sample, sign_off_examples,
//                                          avoid_phrases — user typed these)
//   competitors.description               (user's competitor description)
//   competitors.url, name, css_selector   (user input)
//   changes.content_before, content_after (raw scraped competitor pages)
//   changes.diff_summary                  (raw token diff from scraper)
//
// Replacement strategy (context-aware, not blind):
//   • En-dash inside numeric ranges ("$5K–25K", "4–8") → hyphen
//   • Em-dash between digits ("5—10") → hyphen
//   • En-dash in prose                   → comma + space
//   • " — " (em-dash with spaces) followed by lowercase → ". " + capitalize
//   • " — " followed by uppercase                       → ". " (already capitalized)
//   • Em-dash at start/end                              → strip
//   • Anything else                                     → comma + space (default)
//
// Safety: takes a timestamped backup of the DB file before writing anything.
// Re-running the script after a successful run is a no-op (idempotent: nothing
// to find = nothing to change).

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'competitor-shadow.db');

// ── Replacement engine ──────────────────────────────────────────────────────

function smartReplaceDashes(text) {
  if (text === null || text === undefined || typeof text !== 'string') return { text, count: 0 };
  let count = 0;
  let out = text;

  // 1. En-dash inside numeric/currency ranges → hyphen
  //    Matches "$5K – 25K", "4–8", "Q1–Q3", "100–200"
  out = out.replace(/(\$?\d+(?:[.,]\d+)*[KMB]?)\s*–\s*(\$?\d+(?:[.,]\d+)*[KMB]?)/g, (_m, a, b) => {
    count++; return `${a}-${b}`;
  });

  // 2. Em-dash between digits without spaces (rare but defensive) → hyphen
  out = out.replace(/(\d)\s*—\s*(\d)/g, (_m, a, b) => { count++; return `${a}-${b}`; });

  // 3. Any remaining en-dash (prose) → comma + space
  out = out.replace(/\s*–\s*/g, () => { count++; return ', '; });

  // 4. Em-dash with surrounding spaces, followed by lowercase → period + space + capital
  out = out.replace(/\s+—\s+([a-z])/g, (_m, ch) => { count++; return '. ' + ch.toUpperCase(); });

  // 5. Em-dash with surrounding spaces, followed by uppercase (already a new sentence)
  out = out.replace(/\s+—\s+([A-Z])/g, (_m, ch) => { count++; return '. ' + ch; });

  // 6. Em-dash at very start of string (bullet-like) → strip
  out = out.replace(/^—\s*/g, () => { count++; return ''; });

  // 7. Em-dash at very end → strip
  out = out.replace(/\s*—$/g, () => { count++; return ''; });

  // 8. Anything else (mid-word, no spaces, etc.) → comma + space
  out = out.replace(/\s*—\s*/g, () => { count++; return ', '; });

  return { text: out, count };
}

function cleanJsonField(jsonStr) {
  if (!jsonStr) return { text: jsonStr, count: 0 };
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (_) {
    // Not valid JSON, treat as plain text (defensive)
    return smartReplaceDashes(jsonStr);
  }

  let count = 0;
  function walk(node) {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
      const r = smartReplaceDashes(node);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object') {
      const out = {};
      for (const k of Object.keys(node)) out[k] = walk(node[k]);
      return out;
    }
    return node;
  }
  const cleaned = walk(parsed);
  return { text: count > 0 ? JSON.stringify(cleaned) : jsonStr, count };
}

// ── Stats tracking ──────────────────────────────────────────────────────────

const stats = {};
const allSamples = [];

function track(table, col, rowId, before, after, count) {
  const key = `${table}.${col}`;
  if (!stats[key]) stats[key] = { rows_scanned: 0, rows_modified: 0, replacements: 0 };
  stats[key].rows_scanned++;
  if (count > 0) {
    stats[key].rows_modified++;
    stats[key].replacements += count;
    if (allSamples.length < 50) {
      allSamples.push({
        column: key,
        row_id: rowId,
        replacements: count,
        before: snippet(before),
        after:  snippet(after),
      });
    }
  }
}

function snippet(s, max = 180) {
  if (!s) return '';
  const flat = String(s).replace(/\n+/g, ' ');
  return flat.length > max ? flat.slice(0, max) + '...' : flat;
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  // Backup first
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.pre-dash-strip-${stamp}.bak`;
  fs.copyFileSync(DB_PATH, backupPath);
  console.log(`✓ Backup written: ${backupPath}`);

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  // ── changes ─────────────────────────────────────────────────────────────
  const PLAIN_COLS = ['headline', 'recommended_response', 'historical_context',
                      'gate_reason', 'analysis_error'];
  const JSON_COLS  = ['analysis', 'talking_points'];
  const ALL_CHANGE_COLS = [...PLAIN_COLS, ...JSON_COLS];

  const changesQ = db.exec(`SELECT id, ${ALL_CHANGE_COLS.join(', ')} FROM changes`);
  if (changesQ[0]) {
    for (const row of changesQ[0].values) {
      const id = row[0];
      const updates = [];
      const params = [];
      for (let i = 0; i < ALL_CHANGE_COLS.length; i++) {
        const col = ALL_CHANGE_COLS[i];
        const before = row[i + 1];
        const r = JSON_COLS.includes(col) ? cleanJsonField(before) : smartReplaceDashes(before);
        track('changes', col, id, before, r.text, r.count);
        if (r.count > 0) { updates.push(`${col} = ?`); params.push(r.text); }
      }
      if (updates.length > 0) {
        db.run(`UPDATE changes SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
      }
    }
  }

  // ── generated_playbooks ─────────────────────────────────────────────────
  const PB_COLS = ['subject_line', 'body', 'generation_error'];
  const pbQ = db.exec(`SELECT id, ${PB_COLS.join(', ')} FROM generated_playbooks`);
  if (pbQ[0]) {
    for (const row of pbQ[0].values) {
      const id = row[0];
      const updates = []; const params = [];
      for (let i = 0; i < PB_COLS.length; i++) {
        const col = PB_COLS[i];
        const before = row[i + 1];
        const r = smartReplaceDashes(before);
        track('generated_playbooks', col, id, before, r.text, r.count);
        if (r.count > 0) { updates.push(`${col} = ?`); params.push(r.text); }
      }
      if (updates.length > 0) {
        db.run(`UPDATE generated_playbooks SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
      }
    }
  }

  // ── competitors.last_check_error ────────────────────────────────────────
  const compQ = db.exec(`SELECT id, last_check_error FROM competitors`);
  if (compQ[0]) {
    for (const row of compQ[0].values) {
      const [id, before] = row;
      const r = smartReplaceDashes(before);
      track('competitors', 'last_check_error', id, before, r.text, r.count);
      if (r.count > 0) db.run('UPDATE competitors SET last_check_error = ? WHERE id = ?', [r.text, id]);
    }
  }

  // ── tracked_meetings.briefing_error ─────────────────────────────────────
  const meetQ = db.exec(`SELECT id, briefing_error FROM tracked_meetings`);
  if (meetQ[0]) {
    for (const row of meetQ[0].values) {
      const [id, before] = row;
      const r = smartReplaceDashes(before);
      track('tracked_meetings', 'briefing_error', id, before, r.text, r.count);
      if (r.count > 0) db.run('UPDATE tracked_meetings SET briefing_error = ? WHERE id = ?', [r.text, id]);
    }
  }

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));

  // ── Report ──────────────────────────────────────────────────────────────
  console.log('\n══════════ PER-COLUMN STATS ══════════');
  const order = Object.keys(stats).sort();
  let grandReplacements = 0;
  let grandRowsModified = 0;
  let grandRowsScanned  = 0;
  for (const key of order) {
    const s = stats[key];
    grandReplacements += s.replacements;
    grandRowsModified += s.rows_modified;
    grandRowsScanned  += s.rows_scanned;
    console.log(`  ${key.padEnd(48)} scanned=${String(s.rows_scanned).padStart(3)}  modified=${String(s.rows_modified).padStart(3)}  replacements=${String(s.replacements).padStart(4)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(48)} scanned=${String(grandRowsScanned).padStart(3)}  modified=${String(grandRowsModified).padStart(3)}  replacements=${String(grandReplacements).padStart(4)}`);

  console.log('\n══════════ BEFORE / AFTER (first 5 modifications) ══════════');
  let n = 0;
  for (const s of allSamples) {
    if (n >= 5) break;
    console.log(`\n[${s.column}  row id=${s.row_id}  ${s.replacements} replacement(s)]`);
    console.log(`  BEFORE: ${s.before}`);
    console.log(`  AFTER:  ${s.after}`);
    n++;
  }

  // ── Verification ────────────────────────────────────────────────────────
  console.log('\n══════════ VERIFICATION ══════════');
  const verifyTargets = [
    ['changes', [...PLAIN_COLS, ...JSON_COLS]],
    ['generated_playbooks', PB_COLS],
    ['competitors', ['last_check_error']],
    ['tracked_meetings', ['briefing_error']],
  ];
  let leftover = 0;
  for (const [table, cols] of verifyTargets) {
    for (const col of cols) {
      const r = db.exec(`SELECT COUNT(*) FROM ${table} WHERE ${col} LIKE '%—%' OR ${col} LIKE '%–%'`);
      const count = r[0]?.values?.[0]?.[0] || 0;
      const flag = count === 0 ? '✓' : '✗';
      console.log(`  ${flag} ${table}.${col}: ${count} rows with em/en-dash remaining`);
      leftover += count;
    }
  }

  // Persist a JSON report for the commit
  const reportPath = path.join(__dirname, '..', 'migration-report-dash-strip.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    backup_path: backupPath,
    per_column_stats: stats,
    total_replacements: grandReplacements,
    total_rows_modified: grandRowsModified,
    samples: allSamples.slice(0, 10),
    verification_leftover: leftover,
  }, null, 2));
  console.log(`\nReport written: ${reportPath}`);

  if (leftover > 0) {
    console.error('\nERROR: dashes still present in cleaned columns. Migration incomplete.');
    process.exit(2);
  }

  console.log('\n✓ All targeted columns are now dash-free.');
  process.exit(0);
})();
