# Lemon Squeezy webhook — event mapping

**Endpoint:** `POST /api/webhooks/lemonsqueezy`
**Handler:** `src/lemonSqueezyWebhook.js` → `handleLemonSqueezyWebhook(rawBody, signature, req)`
**Mounted:** `src/server.js`, **before** `express.json()` with `express.raw({ type: '*/*' })` so the HMAC is computed over the exact bytes Lemon Squeezy sent.

This document is the source of truth for how each event mutates workspace state. Review it before pointing a live (test-mode) webhook at the server.

---

## Request pipeline (every delivery)

1. **Signature verification (before parsing).**
   `HMAC-SHA256(rawBody, LEMONSQUEEZY_WEBHOOK_SECRET)` compared to the `X-Signature` header using `crypto.timingSafeEqual` — never `===`. A length mismatch is rejected *before* `timingSafeEqual` (which throws on unequal lengths). Missing/invalid → **401**, and a `webhook_signature_invalid` audit row is written (the provided signature is masked to first/last 4 chars in `event_data`). The body is **never parsed** when the signature fails.
2. **Parse JSON** (only after verification). Unparseable or missing `meta.event_name` → **200** (acknowledged; retrying won't help).
3. **Idempotency.** The verified signature *is* the delivery fingerprint — Lemon Squeezy doesn't put a stable event id in the body, and an identical retry produces an identical body → identical signature. It's stored in `payment_events.lemon_squeezy_event_id` (which is **UNIQUE**). If already present → **200 `{duplicate:true}`** with no reprocessing. The UNIQUE constraint is the final backstop against a concurrent double-delivery.
4. **Record receipt** (`payment_events` row, `status='received'`), then process, then mark `status='processed'` (or `'failed'` + `error` on exception).
5. **Response policy.** Structurally valid event (even a no-op) → **200** so LS does not retry. A genuine processing/DB error → **500** so LS retries (exponential backoff up to ~3 days).

State is driven **only** by these webhooks. The billing routes never write tier/status directly.

---

## Field sources (Lemon Squeezy → local)

| Local column | Source |
|---|---|
| `subscription_id` | `data.id` |
| `subscription_tier` | `variantToTier(data.attributes.variant_id)` → `'pro'` for the Pro variant |
| `subscription_status` | `data.attributes.status`, mapped (see below) |
| `subscription_current_period_end` | `attributes.ends_at` when cancelled, else `attributes.renews_at` |
| `subscription_cancel_at_period_end` | `attributes.cancelled` (boolean) |
| `lemon_squeezy_customer_id` | `attributes.customer_id` |
| `lemon_squeezy_subscription_variant_id` | `attributes.variant_id` |
| workspace link (on `subscription_created`) | `meta.custom_data.workspace_id` (set at checkout) |

**Status map:** `active`/`on_trial`→`active`, `paused`→`paused`, `past_due`/`unpaid`→`past_due`, `cancelled`→`cancelled`, `expired`→`expired`.

The workspace is located by `meta.custom_data.workspace_id` on `subscription_created`, and by `subscription_id` on every later event.

---

## Per-event handling

| Event | Effect on the workspace | Audit | Edge cases |
|---|---|---|---|
| **subscription_created** | Link by `custom_data.workspace_id`: set `subscription_id`, `status='active'`, `tier=variantToTier(variant)`, `current_period_end=renews_at`, `cancel_at_period_end=0`, customer + variant ids. | `subscription_created` | No `workspace_id` in custom_data, or workspace not found → **200 no-op** (logged note). |
| **subscription_updated** | Re-sync `status` (mapped), `tier` (from variant; falls back to current), `current_period_end`, `cancel_at_period_end` from `attributes.cancelled`, variant id. | `subscription_updated` | Unknown `subscription_id` → **200 no-op**. |
| **subscription_cancelled** | `status='cancelled'`, `cancel_at_period_end=1`, `current_period_end=ends_at`. Access continues until `ends_at` (enforced by `getWorkspaceTier`'s grace logic). | `subscription_cancelled` | Unknown sub → 200 no-op. Distinguishes "scheduled to cancel" (still has `ends_at` in the future) from a hard expiry (`subscription_expired`). |
| **subscription_resumed** | `status='active'`, `cancel_at_period_end=0`, refresh `current_period_end`. | `subscription_resumed` | Resume on a never-cancelled sub → idempotent no-harm update, 200. |
| **subscription_expired** | Downgrade: `tier='free'`, `status='expired'`, `subscription_id=NULL`, `cancel_at_period_end=0`. | `subscription_expired` | Unknown sub → 200 no-op. |
| **subscription_paused** | `status='paused'` (tier retained/visible; read-only behaviour handled at the UI). | `subscription_paused` | Unknown sub → 200 no-op. |
| **subscription_unpaused** | `status='active'`. | `subscription_unpaused` | Unknown sub → 200 no-op. |
| **subscription_payment_success** | If currently `past_due` → `active`; refresh `current_period_end` from `renews_at` (COALESCE — never nulls it). | `subscription_payment_succeeded` | Unknown sub → 200 no-op. |
| **subscription_payment_failed** | `status='past_due'`. **Do not downgrade** — Lemon Squeezy runs dunning/retries. | `subscription_payment_failed` | Unknown sub → 200 no-op. |
| **subscription_payment_recovered** | `status='active'`. | `subscription_payment_recovered` | Unknown sub → 200 no-op. |
| _any other_ (`order_created`, `license_*`, …) | None. | — | Acknowledged 200, recorded in `payment_events` as processed. |

---

## Tier resolution & cancellation grace (`src/lib/tierLimits.js → getWorkspaceTier`)

The stored `subscription_tier` is not used raw for gating. `getWorkspaceTier` computes the **effective** tier:

- `tier === 'free'` → `free`.
- `status === 'expired'` → `free`.
- `status` is `cancelled`/`expired` **and** `current_period_end` is in the past → `free` (grace period elapsed).
- `cancelled` but `current_period_end` in the future → keeps the paid tier (the user paid for the period).
- `past_due` → keeps the paid tier (dunning in progress); `paused` → keeps the paid tier (UI enforces read-only).

So a user who cancels keeps Pro until their period ends, and a failed payment doesn't instantly revoke access — both matching Lemon Squeezy's own behaviour.

---

## Verified in-process (checkpoint 2)

- Invalid signature → 401; missing signature → 401 (body never parsed).
- Valid signature `subscription_created` → 200, workspace flips to `pro`/`active` with `subscription_id` linked.
- Replaying the identical delivery → 200 `{duplicate:true}`, exactly **one** `payment_events` row, **one** `subscription_created` audit entry.

Full live test-mode coverage (real checkout, cancel/resume, portal updates) is performed at Phase 10 checkpoint 5.
