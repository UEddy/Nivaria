# Mobile audit — Foresight (Phase A, Tier B: mobile-functional)

**Captured:** 2026-05-28 against `main @ 51aa7eb`, server local.
**Baseline viewport:** 375 × 812 (iPhone SE / 14), `deviceScaleFactor: 2`, `isMobile: true`, `hasTouch: true`.
**Method:** Playwright drove every surface listed in the brief, ran an in-page measurement function on each, and saved a full-page screenshot to `screenshots/mobile-audit/`. Raw findings: `audit-mobile-findings.json` (artifact, not committed).

**Measured per surface:**
- `vw` = `window.innerWidth` after the browser settled. On mobile emulation this is the layout viewport. Any value > 375 means content forced the browser to widen the layout viewport (which then visually zoom-shrinks to fit the device width).
- Elements extending past the viewport's right edge.
- Interactive elements (`a`, `button`, `input`, `select`, `textarea`, `[role=button]`, `[onclick]`, `.nav-item`, `.deals-tab`, `.outcome-btn`) with bounding box < 44 px on either axis — Apple HIG / WCAG 2.5.5 minimum.
- Visible elements rendering own text at < 14 px (with samples).
- Tables and whether each overflows.

**Rating scale (per brief):** **Critical** = page is broken · **High** = workflow doesn't work · **Medium** = works but ugly · **Low** = minor polish.

---

## Headline findings (read this first)

### 🔥 The dominant problem: 9 of 13 app surfaces force a layout viewport wider than 375 px

| Surface | `vw` reported | Caused by |
|---|---:|---|
| Competitors | **1029** | Desktop table with 6 fixed columns + sidebar nav width |
| Brief detail | 710 | Outreach playbook tab row + sidebar layout |
| Dashboard | 616 | Decorative `bg-orb` blurs bleed past viewport |
| Settings | 587 | `form-input` widths inside un-collapsed cards |
| Competitor detail | 560 | Header layout + decorative orb |
| Deal detail | 481 | 3-column stat grid (`deal-detail-grid`) |
| Deals (Log & Manage) | 473 | "Logged deals" inner card width |
| 404 | 382 | Minor — back button row |
| Dashboard, Change Feed, ROI, Pricing, Onboarding, auth pages | 375 | ✓ clean |

When `vw` > 375 the browser auto-zooms the page to fit the device, producing the "everything looks shrunk and tiny" experience visible in `competitors.png` and `settings.png`. **`overflowX` was 0 on every surface** — there is no horizontal scrollbar, the browser is hiding the overflow by shrinking the visual viewport. That's why this didn't get caught by a casual zoom-out check.

**Root causes, in order of impact:**
1. **The competitors table doesn't transform on mobile.** All 6 columns render at full desktop widths, alone enough to push the page to 1029 px. (Phase D.)
2. **Settings form fields and cards have desktop-fixed widths** (`form-input` at 521 px / 427 px inside `set-card`). (Phase F.)
3. **`deal-detail-grid` is `grid-template-columns: repeat(3, 1fr)`** with no mobile collapse rule — it tries to lay out 3 stat cards horizontally at 375 px. (Phase E/D.)
4. **Decorative `bg-orb` / `orb` elements** (434-620 px wide, absolutely positioned) bleed past viewport on pages whose container lacks `overflow-x: hidden`. Visual-only but they inflate `scrollWidth`. (Phase C cleanup, easy.)
5. **Outreach playbook tab row** in Brief detail uses fixed tab widths (148 / 173 / 160 px). (Phase E.)

### ✓ What's already working
- The hamburger toggle exists (`#menu-toggle` is in the markup, sidebar collapses) and the existing `@media (max-width: 768px)` block (`styles.css:2655`) does hide the sidebar on mobile pages where the rest of the layout cooperates (Change Feed, ROI, Pricing, Onboarding, the auth and landing pages are all clean at vw=375). Phase B is rebuild-not-create — there's a foundation. But the full close behaviors, focus management, ARIA, and overlay scrim required by Phase B don't exist yet.
- **No horizontal scroll on any surface.**
- **No table actually overflows its viewport** (the competitors table forces the viewport bigger rather than scrolling) — there is exactly 1 table in the app (`<table>` on Competitors). Easy to handle in one place.
- The auth pages, landing page, Change Feed, Deals → ROI tab, Pricing, and Onboarding hold cleanly at `vw=375`.

### Cross-cutting issues (apply to almost every surface)

| # | Issue | Surfaces | Rating | Fix scope |
|---|---|---|---|---|
| X1 | Button base styles routinely `height: 28-32-36 px` — below 44 px Apple HIG minimum | every page | **High** (touch ergonomics across the app) | Single rule: `@media (max-width: 767px) .btn { min-height: 44px; }`. Cascade through `.btn-sm`. Re-test that desktop spacing doesn't break. |
| X2 | Icon-only buttons (edit/delete row, theme toggle, eye-toggle, menu-toggle) are 20-38 px on both axes | every page with row-actions, all topbars | **High** | Mobile padding bump + `min-width: 44px; min-height: 44px;`. Theme toggle group needs separate treatment. |
| X3 | `title=""` tooltips on icon-only buttons (`title="Edit"`, `title="Delete"`, `title="Check now"`) are invisible on touch | Competitors row actions, Deals row actions | **High** (workflow — user can't tell what icons do) | Phase G replacement: visible labels in the row card transform, or accessible aria-label + visible-on-tap helper. |
| X4 | Decorative `bg-orb` / `orb` blurs render past viewport, inflating `scrollWidth` | Dashboard, Competitor detail, Brief detail, Deal detail, Settings, Change Feed, ROI, Pricing, Onboarding, 404, auth | **Medium** (visual is fine, but contributes to the vw-inflation problem above) | Add `overflow-x: clip` to `.app-shell` / `.auth-wrap` outer container. Or shrink orbs at `<768px`. ~10 lines of CSS. |
| X5 | Body chrome text at 10-12 px: `nav-section-label`, `logo-sub`, `user-email`, `plan-name`, `hero-stat-label`, `bc-section-label`, `pattern-tag`, `outreach-regen-count`, `comp-avatar` | every authed page | **Medium** | Mobile floor: 11.5 px for badges/pills, 13 px for labels, 14 px for prose. Most are already at 11+ — issue is in aggregate, not any one element. |
| X6 | Existing media queries are scattered hardcoded `max-width` values at 480, 640, 720, 768, 900, 1100 — no token system | `styles.css` | **Low** (not user-facing) | Document and standardize on 640 / 768 / 1024 per spec, keep 720/900/1100 as legacy intermediate breakpoints until Phase J verifies removal is safe. CSS custom properties cannot live inside `@media` queries, so this stays as documented constants. |

---

## Per-surface findings

### Landing page  `/`  ·  vw: 375 ✓
Clean. The marketing page is responsive (it has its own `lp-mobile-menu-btn`, designed mobile-first).
- **Low** — Mock dashboard preview chips at 10 px (`lp-mock-stat-label`, `lp-mock-badge`, `lp-mock-time`). Stylistically tiny but intentional inside the mock; leave.
- **Low** — `a.lp-plan-cta` rendered at 18 px tall (text-only link). Pricing cards use real buttons elsewhere; this one anchor in a plan tile is a tap-miss risk.

### Auth pages  `/login`, `/register`  ·  vw: 375 ✓
All five views (login / signup / verify-OTP / forgot-email / reset-password) render at 375 cleanly.
- **High** — `button.theme-btn` is 28 × 26 (in the topbar corner of every auth screen). Sub-44 in both dimensions. Affects all four+landing too. (X2.)
- **High** — `button.eye-toggle` (show/hide password) is 20 × 20 inside the password input.
- **High** — `button.back-btn` "Back" / "Back to sign in" is 16-17 px tall. Easy tap-miss.
- **High** — Login "Remember me" checkbox `input#inp-remember` is 14 × 14 with no enclosing tap area expansion.
- **Medium** — `button.link-btn` "Forgot password?" rendered at 15 px tall and 12 px font.
- **Medium** — Reset-password rule list (`pw-rule`) all 12 px. Functional but cramped on small phones.
- **Low** — Form labels `.form-label` at 12.5 px (intentional small-caps style). Borderline.

### Dashboard  `#/`  ·  vw: 616 (decorative orbs)
**Works on mobile.** Layout collapses: hamburger, single-column widgets, ROI widget stacks below hero stats. The 616 vw is the `bg-orb-2` blur, not real content.
- **Medium** — `a.feed-link` (icon-only "open" link inside change-feed row) is 32 × 22. (X2.)
- **Medium** — Hero stat labels at 11 px. The big numbers (huge font) carry the meaning; labels are fine but borderline.
- **Low** — "View all →" / "Manage →" ghost buttons at 86-100 × 32. (X1.)
- **Low** — `bg-orb` decorative element extends past viewport. (X4.)
- **Low** — `a` "Manage account" in sidebar is 88 × 14. Sidebar is drawer-only on mobile, will be re-styled in Phase B.

### Competitors  `#/competitors`  ·  vw: **1029** 🔥
**CRITICAL — page is fundamentally broken on mobile.** Desktop table doesn't transform; browser zoom-shrinks the whole page to ~36% to fit. Text is microscopic; tap targets are sub-20 px effective.
- **Critical** — `<table>` doesn't collapse. Single CSS rule won't fix this; needs a real card-stack transform under `<768px` (Phase D). Each row should become a card with: competitor name + URL, status pill, last-check time, change count, and a 3-dot menu for `Check/Edit/Pause/Delete`.
- **High** — `a.change-count-link` is 6-9 px wide (just a number). Whole `<td>` should be the tap target; in card form this becomes its own row.
- **High** — Row icon buttons (edit / delete / pause / check) at 38 × 24. (X2.)
- **High** — Long competitor URLs like `acmecorp.com/pricing` shown in a 155 × 20 link — fine width, but `whitespace: nowrap` on URL will cause overflow with longer URLs. Need truncation with ellipsis. (Phase H smart truncation.)
- **Medium** — Headers `<th>` all 11 px (irrelevant once table becomes cards).

### Competitor detail  `#/competitors/1`  ·  vw: 560
**Mostly works** — the timeline is naturally vertical. The 560 width comes from the header row layout + orb.
- **Medium** — `cd-feed-date` 12 px, pattern tags 10 px. Cramped but readable.
- **Medium** — Header has fixed-width "Back to Competitors" (172 × 32) — needs to wrap or shorten on mobile.
- **Low** — `cd-url` link 161 × 21. Tappable, but a bigger target would be friendlier.

### Change Feed  `#/history`  ·  vw: 375 ✓
**Works.** Cards stack, filters wrap.
- **High** — Filter chips (`.filter-btn`) at h:30. (X1.)
- **Medium** — `comp-avatar` is 9 px font for the 2-letter monogram (e.g., "AC", "HA"). Visually tiny but it's a decorative avatar — leave or bump to 10.
- **Medium** — Badges (HIGH / MEDIUM / LOW) at 11 px. OK as pills.

### Brief detail  `#/history/1`  ·  vw: 710  ←  **most critical mobile surface per brief**
**Works reasonably well** — typography is readable, sections separate, copy works. The 710 px is the outreach tab row width: 148 + 173 + 160 ≈ 481 + container padding.
- **High** — Outreach playbook tabs row forces the page wider than 375. Tabs need to either stack vertically on mobile, scroll horizontally with a clear edge-fade, or compress labels (Phase E primary deliverable).
- **High** — "Copy" / "Edit" / "Regenerate" buttons in the playbook footer at h:28. (X1.)
- **High** — Section labels (`bc-section-label`) all at 10.5 px. These are the navigation anchors of the brief — bump to 12 on mobile.
- **Medium** — Long URLs `bc-comp-url` 156 × 20.
- **Medium** — Pattern tags inside Key Changes at 10 px.
- **Low** — `outreach-regen-count` badge "↻13" at 10 px. Pill-style, OK.

### Deals — Log & Manage  `#/deals`  ·  vw: 473
**Works but cramped.** The "Logged deals" card has internal min-width.
- **High** — Deal row icon buttons (edit, delete) at 38 × 24. (X2.)
- **High** — `deals-tab` row (Log & deals / ROI dashboard) at h:39. Below 44.
- **Medium** — `card-sub` 12 px description.
- **Medium** — Deal pills (Won/Lost/Stalled) at 11 px. OK.
- **Low** — "Log a deal" primary CTA at h:28. (X1.)

### Deals — ROI dashboard  `#/deals?tab=roi`  ·  vw: 375 ✓
**Clean.** Stacks well. Pattern cards readable.
- **High** — "Set up alert" button h:28 and "X supporting deals" ghost button h:28. (X1.)
- **Medium** — `pattern-impact-label`, `roi-headline-label`, `roi-headline-note`, `conf-pill` all 10.5-12 px. Acceptable for labels but borderline.

### Deal detail  `#/deals/1`  ·  vw: 481
**Mostly works.** Header info readable, timeline natural. The 481 px comes from `deal-detail-grid` 3-column layout.
- **High** — `deal-detail-grid` is `repeat(3, 1fr)` with no mobile collapse — should be 1 column under 640 (or 2 column on tablet, 1 on mobile). Single CSS rule.
- **High** — Header Edit / Delete buttons at h:28. (X1.)
- **Medium** — Deal stat labels at 11 px ("Value", "Close date", "Source"). OK if widened to 1 col.

### Settings  `#/settings`  ·  vw: 587  🔥
**CRITICAL on mobile** — settings is one of the most-used surfaces and form inputs are way too wide for 375 px, causing zoom-shrink. The screenshot is essentially illegible at device size.
- **Critical** — `form-input` fields at 521 × 39 / 427 × 39 inside cards that don't shrink under `<768px`. Cards need a real `max-width: 100%` and inputs need to honor card width. Phase F primary deliverable.
- **High** — `briefings-enabled.set-switch` toggle is 38 × 22 — sub-44.
- **High** — "Save changes" button per card at h:28. (X1.) On mobile these should be card-footer full-width.
- **High** — "Show" / "Copy" buttons next to API key at 51-60 × 28. (X1.)
- **High** — "Test" webhook button 51 × 28. (X1.)
- **High** — Plain `input` (checkbox, 13 × 13) for severity toggles. Wrap in `<label>` for big tap area.
- **Medium** — Tier badges ("Soon", "Setup needed") at 10.5 px. OK.
- **Medium** — "Connect Google Calendar", "Add to Slack", "Microsoft 365" buttons truncated mid-word in the screenshot at the shrunk viewport. Will resolve once parent fits.
- **Medium** — Long page (h: 4943 px). Sticky save buttons per card are mentioned in spec; current pattern is one save button per card which is fine if each becomes full-width on mobile.

### Pricing  `#/pricing`  ·  vw: 375 ✓
**Clean.** Plans stack to single column.
- **Medium** — Plan name text at 12 px. The price headline carries the visual weight.
- **Low** — "Most Popular" tag 11 px. Pill style.

### Onboarding  `#/onboarding`  ·  vw: 375 ✓
**Clean.** Form fields full width-ish (305 px on a 375 viewport — could go wider).
- **High** — `Skip for now` and `Save and continue` buttons at h:35. Below 44. (X1.)
- **Medium** — Step indicator label at 12 px ("Step 1 of 3 · Business context").
- **Medium** — `form-hint` ("Shown on your briefs as…") at 11.5 px.

### 404 page  `#/zzz-no-such-page`  ·  vw: 382
**Mostly works.** 7-pixel overflow.
- **Low** — Whatever pushes vw to 382 (likely the topbar Back arrow + page-title overlap). Trivial.

### Add Competitor modal  `Competitors.showAddModal()`  ·  vw: 1029 (inherits)
**Critical** — but the cause is the underlying Competitors page (#5 critical above). The modal itself, once viewed at proper scale, is fine: inputs, labels, action buttons all render correctly. On mobile this should become a bottom sheet anyway (Phase G).
- **Critical** — Inherits Competitors page vw of 1029.
- **High** — Modal close `×` (`button.modal-close`) likely sub-44. (Not in this run's `smallTouch` list because the modal didn't render fully — see note below.)
- *Note:* The audit screenshot shows the modal at full scale (because the screenshot is scaled to fit). The measurement function did not pick up modal-specific elements (inputs etc. don't appear in `smallTouch`), suggesting modal animation hadn't completed when measurement ran. Re-audit in Phase G after the bottom-sheet conversion.

### Log Deal inline form  `#log-toggle` click  ·  vw: 473 (inherits)
**Same as Deals — Log & Manage above.** The form opens within the existing Deals card, so inherits its layout.
- **High** — Form row (`.log-row`) uses `flex-wrap` already and partial mobile collapse via `@media (max-width: 720px)` at `styles.css:2805`. Verify on real 375 viewport whether it collapses cleanly (couldn't tell from this run because the parent was at 473).

### Delete confirmation modal  `Competitors.remove(...)`  ·  vw: 1029 (inherits)
**Same architecture issue as Add Competitor modal.** Confirmation dialogs are exactly the use case the brief calls out for bottom sheets — short content, single binary decision, swipe-to-dismiss.

---

## Suggested sequencing (informs Phases B-J)

The findings cluster naturally into the phase plan you wrote, with a couple of priority shifts worth flagging:

1. **Phase B (Nav rebuild) — highest priority.** Foundation is partly there (`#menu-toggle` exists, sidebar collapses on `<768`), but the full close behaviors, scrim, ARIA, focus management, and the X1/X2 universal touch-target fix should land in this phase too — every other phase depends on a working nav, and the touch-target rule is one CSS block.
2. **Phase D (Lists → cards)** should come right after B because the Competitors table is the single worst surface in the app and the fix is well-defined. Recommend doing the competitors transformation first, then change-feed (already cards), then deals list.
3. **Phase F (Forms / Settings)** is the second-worst Critical surface. Suggest moving Phase G (bottom-sheet modals) to **after** Phase F, because Add Competitor / Edit Competitor modals contain forms and you'll want the form mobile rules already established before re-skinning the modal shell.
4. **Phase E (Detail pages)** is the explicit pause point and the most-likely-tapped-from-Slack surface. Brief detail is in moderate shape — the dominant issue is the outreach tabs forcing width. Suggest landing this third (after B + D) so a real "tap from Slack → read brief" path works end-to-end.
5. **Phase C (Dashboard)** — lowest urgency, mostly already works. Recommend folding into Phase B's CSS pass (overflow:clip + orb sizing).
6. **Phase H (Native share / tel: / mailto:)** — small standalone phase, can land any time after Phase E.
7. **Phase I (Touch targets)** — most of this should fall out of the X1/X2 single-CSS-rule in Phase B. Phase I becomes a verification pass + per-component exceptions, not a separate sweep.
8. **Phase J (Cross-breakpoint testing)** — re-run this same audit script at 320, 414, 768, 1024, 1440 alongside the manual end-to-end workflows.

**Scope estimate (best-guess hours):**
B: 6h · C: 1h (folds into B) · D: 5h · E: 4h · F: 6h · G: 4h · H: 2h · I: 2h (verification) · J: 3h.
Total: ~32-35 hours. Most of the work is concentrated in B+D+F+G.

---

## Risks worth flagging before code starts

1. **CSS regression on desktop.** The existing 720 / 900 / 1100 / 480 max-width queries are entangled with the layout. Standardizing on 640 / 768 / 1024 risks breaking intermediate widths if I don't keep the legacy rules until Phase J verifies. Plan: add new rules, leave old, remove only after Phase J cross-breakpoint pass.
2. **`overflow-x: clip` on `.app-shell`** to contain the decorative orbs has a side-effect on any element that uses `position: sticky` inside (sticky can break under `overflow: clip`). Brief detail and Deals page have sticky elements — verify case-by-case.
3. **The competitors table → cards transform** changes the underlying HTML structure on mobile, not just CSS. Either I keep both renderings (CSS show/hide based on viewport) or I render once and CSS-grid-flip. Recommend the latter: a single semantic `<ul>` of rows that on desktop is CSS-Grid'd into a table-like layout and on mobile stacks. Cleaner accessibility too.
4. **Modal → bottom sheet** changes the modal's animation, dismissal, and focus-trap. The existing `openModal()`/`closeModal()` API in `app.js:308-320` is simple (set innerHTML, toggle `.open` class). I'll need to preserve that API surface and layer the bottom-sheet behavior in, so the 6+ existing callers don't need changes.
5. **`hasTouch + isMobile` in Playwright is an emulation, not a real device.** Phase J should include at least one real-device check on iOS Safari (touch latency, momentum scroll, safe-area-insets, viewport meta interpretation).

---

## What this audit did NOT cover (deferred to Phase J or future)

- Real device testing (iOS Safari, Android Chrome). Emulation only here.
- Tablet-portrait (768 px) and tablet-landscape (1024 px) — only 375 captured in this pass; Phase J explicitly walks 320 / 375 / 414 / 768 / 1024 / 1440.
- Reduced-motion behavior on mobile.
- Performance / payload size on mobile networks.
- Screen-reader walkthrough (VoiceOver / TalkBack). The brief-listed accessibility items (focus management, ARIA, contrast) will be checked in Phase B + I; full SR audit is out of scope for Tier B.
- Print stylesheet (if any).
