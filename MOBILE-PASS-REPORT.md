# Foresight — Mobile Pass: Comprehensive Report (Phases A–J)

> **Note:** The project was renamed to Nivaria on 2026-06-02. This report uses the project's original name "Foresight" as it described historical work.

**Closing report for the end-to-end mobile responsiveness pass.**
Baseline: `main @ 51aa7eb` (2026-05-28). Closed: Phase J, 2026-05-30.

---

## 1. By the numbers

| Metric | Value |
|---|---:|
| Phases | A → J (10) |
| Commits (mobile pass) | 11 (incl. Phase J) |
| Code files changed | 7 |
| Code lines | **+1,466 / −108** |
| Total files touched (incl. screenshots/scripts) | 165 |
| Surfaces verified | 13 |
| Breakpoints verified | 320 / 375 / 414 / 768 / 1024 / 1440 |
| Coverage cells | 78 / 78 pass |

**Code footprint** (everything else is screenshots + regenerable diagnostics):

| File | Δ | Role in the pass |
|---|---:|---|
| `public/css/styles.css` | +912 | All mobile CSS: drawer, card stacks, forms, bottom sheets, touch floor, focus, contrast |
| `public/js/app.js` | +304 | Drawer controller, modal/bottom-sheet, focus trap+restore, native share, toast |
| `public/js/competitors.js` | +279 | Table → card-stack transform + inline kebab menu |
| `public/app/index.html` | +32 | Drawer markup, ARIA roles/labels, dialog + live-region wiring |
| `public/js/battlecard.js` | +23 | Brief mobile layout + outreach tab scroll |
| `public/js/deals.js` | +20 | Deal-row actions, tab ARIA |
| `public/js/settings.js` | +4 | Mobile form glue |

No backend (`src/`) changes — the entire pass was front-end.

---

## 2. Phase-by-phase deliverables

| Phase | Commit | Key deliverable |
|---|---|---|
| **A** Audit | `5e56344` | Data-driven audit of 13 surfaces at 375px. Found the dominant bug: 9/13 surfaces forced a layout viewport > 375px → silent browser zoom-out. `audit-mobile.md`. |
| **B** Nav (+ C folded in) | `ada5cd3` | Off-canvas hamburger drawer with full close behaviour (tap/scrim/X/Escape/swipe/route/resize), scrim, ARIA, focus move/restore. The universal `<1024px` 44px touch-target floor. `overflow-x: clip` on `.app-shell` + orb shrink (Phase C dashboard work folded in here). |
| **D** Lists → cards | `0462cc3`, `0c34d32` | Competitors desktop table → card stack at `<1024px` (the worst surface, vw=1029 → fixed). Inline kebab disclosure menu. |
| **E** Detail pages | `c19a590`, `e74f369` | Readable briefs, horizontally-scrolling outreach playbook tabs (was forcing vw=710), competitor/deal timelines, stacked detail grids. |
| **F** Forms | `103148e` | 16px inputs (kills iOS auto-zoom), full-width stacked actions, sticky save bars, iOS safe-area insets — Settings (vw=587) fixed. |
| **G** Modals | `4050794` | Modals → bottom sheets at `<=639px` with swipe-down dismiss + grab handle; toasts re-anchored to the top (clear of the keyboard). |
| **H** Patterns | `780b105` | Native `navigator.share` with clipboard fallback; tappable contacts; smart long-URL truncation; honest loading states. |
| **I** Accessibility | `dfab0fa` | 44px audit (data-driven), 8px adjacency, `:focus-visible` everywhere + focus-trap in drawer/modal + focus restore, **WCAG AA contrast fix** (`--txt-3` 2.6:1 → ~5.0:1), ARIA roles/labels on dialogs, toasts, icon buttons, tabs. |
| **J** Close-out | *this commit* | Full 13×6 breakpoint matrix (0 overflow), CSS consolidation (dead drawer rules + conflicting toast blocks removed, proven zero visual change), Slow-3G performance baseline, final screenshots, this report. |

---

## 3. Before vs after — the headline

| | Before (audit baseline) | After (Phase J) |
|---|---|---|
| **Silent zoom-out** | 9/13 surfaces forced layout viewport 382–1029px; browser shrank pages to fit (Competitors ≈ 36%) | **Gone.** Every surface renders at the device width; 0px horizontal overflow at 320–1440px. |
| **Competitors** | Desktop 6-col table, microscopic, sub-20px taps | Card stack, full-width "Check now", 44px targets |
| **Settings** | Form fields 521px wide inside non-shrinking cards; illegible | Single-column cards, full-width inputs + save buttons |
| **Touch targets** | Buttons 28–38px, icon buttons 20px, sub-44 everywhere | 44px floor `<1024px`; audited clean at 375/414/768; documented exceptions only |
| **Accessibility** | No focus management, no focus trap, icon buttons unlabeled, no dialog/live-region roles | Visible focus on all controls, focus trapped + restored in drawer/modal, ARIA roles/labels in place |
| **Contrast** | `--txt-3` muted text ≈ 2.6:1 (fails AA) | ≈ 5.0:1 (passes AA 4.5:1) across the off-black surfaces |
| **Modals** | Centered desktop dialog, no mobile affordance | Bottom sheets, swipe-to-dismiss, safe-area aware |

---

## 4. Phase J specifics

### CSS consolidation (pure refactor — zero visual change, proven)
1. **Legacy `@media (max-width: 720px)` block.** Its drawer rules (`--sidebar-w`, `.sidebar` transform/width, `.sidebar.open`, `.main-wrapper`, `.menu-toggle`) were fully superseded by Phase B's `767px` block (same specificity, later in source) — **dead code, removed**. Its `.hero-stats-grid` rule duplicated the `1100px` block's 2-column layout — **removed**. Kept only the genuinely-unique 640–720px output (page/topbar padding, hero value size).
2. **Conflicting toast blocks.** Phase E anchored the mobile toast to the bottom; Phase G re-anchored it to the top, leaving Phase E's `bottom` rule dead. **Merged into a single `<=639px` toast block** (top-anchored + the sizing that Phase E uniquely contributed).

**Proof of no regression:** computed-style snapshots at 639/700/720/760/767/768px before vs after consolidation were **byte-identical** (excluding a transform value mid-CSS-transition, a measurement artifact). The 720–768px band — the one the audit flagged as risky — is unchanged.

### Performance baseline (diagnostic only)

Slow 3G (400 kbps, 400 ms RTT) @ 375px vs normal connection @ 1440px:

| Page | 3G FCP | 3G content visible | 3G load | Desktop FCP | Desktop interactive |
|---|---:|---:|---:|---:|---:|
| Dashboard | 9,176 ms | 11,811 ms | 11,782 ms | 692 ms | 586 ms |
| Brief detail | 9,228 ms | 10,465 ms | 10,438 ms | 644 ms | 548 ms |
| Change Feed | 9,240 ms | (≈10,555 ms*) | 10,555 ms | 648 ms | 533 ms |
| Deals | 9,204 ms | 10,763 ms | 10,524 ms | 632 ms | 527 ms |
| Settings | 9,168 ms | 11,335 ms | 11,315 ms | 692 ms | 588 ms |

\* Change Feed's content probe hit a selector-wait timeout; its real `load` (10.5s) is in line with the others.

**Read:** FCP clusters tightly at ~9.2s on Slow 3G across *all* pages — the cost is the **shared shell**, not any one page. The dominant contributors are render-blocking Google Fonts (two families, multiple weights), a single 143 KB unminified `styles.css`, and 11 separate unbundled/unminified JS files. Desktop is healthy (~650 ms FCP). The mobile↔desktop gap is **entirely network-transfer-bound** and was **not introduced by the mobile pass** — it's a pre-existing build-optimisation gap. No single page is pathologically slow.

---

## 5. Deferred / filed as future follow-ups

| # | Item | Why deferred |
|---|---|---|
| a | **Keyboard-operable div-rows** (deal-row, feed-item are clickable `<div>`s) | Keyboard reachability is preserved today via inner anchor links; making whole rows operable (tabindex+role+key handler) is its own focused 1–2h change for launch-polish time, not Phase J cleanup scope. |
| b | **Light-theme `--txt-3` marginal contrast** (~4.3:1 on tinted cards) | Phase I's contrast scope was explicitly the off-black/dark surfaces (default theme). Light-theme token is a small separate tweak. |
| c | **`mailto:` links** for support | No support address domain exists yet; wire when it does (Phase H filed this). |
| d | **Inline info-icon-on-tap** for the "Trivial changes are gated…" tooltip | Desktop `title=` tooltips are invisible on touch; needs a tap-reveal affordance. Minor UX polish. |
| e | **Express login rate-limiter test-mode bypass** | The 100 req/15min API limiter forces server restarts between test runs. A `RL_DISABLE`-style env bypass would streamline future automated passes. Build/test ergonomics, not product. |

---

## 6. Honest production-readiness assessment

**Mobile layout, interaction, and accessibility: genuinely production-quality.**
- No silent zoom-out anywhere; 0px overflow at 320–1440px across all 13 surfaces, verified data-driven, not by eyeball.
- Touch targets meet the 44px standard at every mobile breakpoint, with the handful of exceptions documented and defensible (inline text links, redundant affordances).
- Keyboard and screen-reader support is real: visible focus, focus trapping and restoration in overlays, dialog/live-region/tab roles, labelled icon controls.
- Contrast passes WCAG AA on the dark surfaces.
- Desktop is provably unchanged (matrix + computed-style diff).

**Two honest caveats before calling it "done" for a mobile-heavy launch:**

1. **Performance on constrained networks is the one substantive gap.** ~9s to first paint on Slow 3G is poor for a mobile-first audience. It's not a layout problem and nothing in this pass caused it — it's render-blocking fonts + unminified/unbundled assets. **Recommend a dedicated performance phase** (bundle+minify JS, self-host/subset + `font-display: swap`, enable gzip/brotli, defer non-critical JS) before heavy mobile acquisition. On a fast connection the app is snappy (~650 ms FCP).

2. **Testing is Playwright emulation, not real devices.** Emulation is faithful for layout/overflow/touch-target geometry, but real iOS Safari / Android Chrome should still get a pass for momentum scroll, touch latency, `env(safe-area-inset-*)` on a notched device, and the bottom-sheet swipe feel. This is the standard "emulation ≠ device" caveat, not a known defect.

**Bottom line:** the mobile *experience* — what a user sees, taps, reads, and navigates — is production-ready. The mobile *delivery* (asset performance on slow networks) is the next thing to fix, and it's a clean, well-scoped follow-up rather than a blocker for the experience itself.
