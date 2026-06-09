// One-shot codemod: replace residual hardcoded indigo (and recalibrate MED
// severity yellow→orange) with the gold brand palette. Token *solids* are edited
// by hand in the source; this handles the mechanical rgba triplets + inline hexes.
// Per-file rules avoid clobbering decorative palettes (avatar variety, the admin
// "dev" pill) that intentionally stay amber. email.js (deep-gold, on white) and
// legal.js (out of scope) are NOT processed here.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// Triplet rgb values (used inside rgb()/rgba()), matched with flexible spacing.
const T = {
  indigo:   [/99,\s*102,\s*241/g,  '202,138,4'],   // #6366F1 → bright gold
  indigoLt: [/79,\s*70,\s*229/g,   '161,98,7'],     // #4F46E5 → deep gold
  indigo3:  [/129,\s*140,\s*248/g, '202,138,4'],    // #818CF8 → bright gold
  amber:    [/245,\s*158,\s*11/g,  '234,88,12'],    // #F59E0B → MED orange
};
// Hex replacements (case-insensitive).
const H = {
  i1: [/#6366F1/gi, '#CA8A04'],  // indigo        → bright gold
  i2: [/#818CF8/gi, '#E3A008'],  // light indigo  → mid gold (gradient ends)
  i3: [/#4F46E5/gi, '#A16207'],  // deep indigo   → deep gold
  i4: [/#4338CA/gi, '#854D0E'],  // darker indigo → darker gold (light-mode text)
  i5: [/#C7D2FE/gi, '#FCD34D'],  // pale indigo   → pale gold
  i6: [/#A5B4FC/gi, '#FCD34D'],  // indigo-300    → pale gold
  amber: [/#F59E0B/gi, '#EA580C'], // amber       → MED orange
};

const FILES = {
  'public/css/styles.css':     [T.indigo, T.indigoLt, T.amber, H.i1, H.i2, H.amber, H.i5],
  'public/css/landing.css':    [T.indigo, T.indigoLt, T.amber, H.i1, H.i2, H.i3, H.amber],
  'public/auth/index.html':    [T.indigo, T.indigoLt, H.i3, H.i4, H.i5, H.i6],
  'src/routes/admin.js':       [T.indigo3, H.i6],                 // NOT amber: keep pill-dev
  'public/js/dashboard.js':    [T.indigo],
  'public/js/animations.js':   [T.indigo, T.indigoLt],
  'public/js/app.js':          [H.i1, H.i3],                      // avatar pair; NOT amber
  'public/index.html':         [H.i1, H.i3],
};

let grand = 0;
for (const [rel, rules] of Object.entries(FILES)) {
  const fp = path.join(root, rel);
  let src = fs.readFileSync(fp, 'utf8');
  let fileCount = 0;
  for (const [re, to] of rules) {
    const m = src.match(re);
    if (m) { fileCount += m.length; src = src.replace(re, to); }
  }
  fs.writeFileSync(fp, src);
  grand += fileCount;
  console.log(`${rel.padEnd(28)} ${fileCount} replacement(s)`);
}
console.log(`\nTotal: ${grand} replacement(s) across ${Object.keys(FILES).length} files`);
