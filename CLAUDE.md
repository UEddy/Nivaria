# Nivaria — project conventions for Claude Code

Nivaria is a competitive-intelligence app for SaaS sales teams (Node/Express
backend, vanilla-JS SPA under `public/`, sql.js database, Anthropic API for
analysis/outreach, Lemon Squeezy billing).

## Typography: no em-dashes or en-dashes in user-facing output

**No em-dashes (`—`, U+2014) or en-dashes (`–`, U+2013) may ever appear in
user-facing output anywhere in this project.** This is a hard rule. It applies
to:

1. All UI copy, labels, tooltips, modals, empty states, and error messages.
2. All landing-page and marketing copy.
3. All email templates.
4. All AI-generated content. Every prompt sent to the Anthropic API (brief
   generation, outreach playbooks, briefing condenser, severity analysis) must
   include an explicit instruction that the model never uses em-dashes or
   en-dashes in its output.
5. All copy that Claude Code writes in any future commit.

Replace a dash with a **period, comma, colon, or parentheses** depending on
context. `", "` is the safe programmatic default.

**Ordinary hyphens (`-`) in compound words are fine and must NOT be touched**
(e.g. "pre-meeting", "anti-bot", "win/loss"). Only the em-dash and en-dash
characters are forbidden.

### Enforcement (two layers)

1. **This document** — every session inherits the rule from `CLAUDE.md`.
2. **A runtime post-processor** — `src/lib/sanitizeText.js` exports
   `stripDashes(str)` and `sanitizeDashesDeep(obj)`. Before any AI-generated
   text is stored or displayed it is run through one of these, because LLM
   output is stylistically sticky and prompt instructions alone occasionally
   fail. Current wiring:
   - `src/analyzer.js` — `sanitizeDashesDeep` over the parsed brief in
     `tryParseAnalysis`, before the analysis is returned/persisted.
   - `src/playbooks.js` — `stripDashes` inside `applyVoiceFilters` on every
     generated outreach subject/body.
   - `src/briefingDispatch.js` — `stripDashes` over each condensed pre-meeting
     talking point.
   - `src/routes/legal.js` — `stripDashes` over the rendered legal article HTML
     (the source docs are third-party boilerplate we extract verbatim).

   When you add a new AI call site or a new surface that renders model output,
   wire the same post-processor and add the no-dash instruction to its prompt.
