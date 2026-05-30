# Phase J — Cross-breakpoint coverage matrix

**Generated:** 2026-05-30, `phase-j.js matrix` against local server, post-consolidation.
**Method:** each surface loaded at six viewport widths (mobile emulation < 1024px, desktop ≥ 1024px). Per cell we measure the layout viewport (`window.innerWidth`), the document `scrollWidth`, and the horizontal overflow (`scrollWidth − innerWidth`). **Pass = overflow ≤ 1px** (no content forces the layout viewport wider than the device, which is what produced the original "silent zoom-out").

Derived live IDs this run: competitor `#11`, brief `#13`, deal `#1`.

## Surface × breakpoint

`ok` = 0px overflow, layout viewport equals device width. The **"audit vw"** column is the original Phase A finding (375px emulation) — the layout viewport the page forced *before* the mobile pass.

| Surface | audit vw (before) | 320 | 375 | 414 | 768 | 1024 | 1440 |
|---|---:|:--:|:--:|:--:|:--:|:--:|:--:|
| Dashboard | 616 | ok | ok | ok | ok | ok | ok |
| Competitors | **1029** 🔥 | ok | ok | ok | ok | ok | ok |
| Competitor detail | 560 | ok | ok | ok | ok | ok | ok |
| Change Feed | 375 ✓ | ok | ok | ok | ok | ok | ok |
| Brief detail | 710 | ok | ok | ok | ok | ok | ok |
| Deals (Log & Manage) | 473 | ok | ok | ok | ok | ok | ok |
| Deals (ROI dashboard) | 375 ✓ | ok | ok | ok | ok | ok | ok |
| Deal detail | 481 | ok | ok | ok | ok | ok | ok |
| Settings | **587** 🔥 | ok | ok | ok | ok | ok | ok |
| Pricing | 375 ✓ | ok | ok | ok | ok | ok | ok |
| Onboarding | 375 ✓ | ok | ok | ok | ok | ok | ok |
| 404 | 382 | ok | ok | ok | ok | ok | ok |
| Add Competitor modal | 1029 (inherited) | ok | ok | ok | ok | ok | ok |

**78 / 78 cells pass. Zero horizontal overflow at any width.**

## Verification notes

- **The two critical surfaces are fixed at the root.** Competitors (was vw=1029, the desktop table that zoom-shrank the whole page to ~36%) now sits at exactly 320/375/414px as a card stack. Settings (was vw=587) now equals the device width at every breakpoint.
- **`scrollWidth == innerWidth` at every cell.** The decorative `bg-orb` blurs are the widest element on most pages, but `overflow-x: clip` on `.app-shell` contains them, so they no longer inflate `scrollWidth`. The "worst element" probe never exceeds the viewport's right edge by more than the 1px sub-pixel tolerance.
- **320px** (smallest target, iPhone SE 1st-gen / fold outer) is clean on every surface, including the dense card stacks and the 3-up segmented controls (which flex to fill).
- **768 / 1024 / 1440** confirm no desktop or tablet regression from the mobile work or the Phase J CSS consolidation.
- The **720–768px band** (where the legacy `@media max-width:720px` block overlapped Phase B's `767px` drawer block) was verified separately by computed-style snapshot diff before/after consolidation — **identical** across 639/700/720/760/767/768px.

Raw data: `phase-j-coverage.json` (git-ignored, regenerable via `node screenshots/phase-j.js matrix`).
