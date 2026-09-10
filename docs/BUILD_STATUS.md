# Build Status

Tracks execution of `docs/BUILD_PLAN.md`. Update this file as part of every milestone-advancing
change — a stale status file is a defect.

**Last updated:** 2026-09-09
**Phase:** All five milestones complete. P0 done.

**Deployed:** https://billing-investigator.om-bhatt.workers.dev

**Status values:** `pending` · `in_progress` · `blocked` · `complete`

---

## Milestones

| # | Milestone | Status | Exit criterion |
|---|---|---|---|
| 1 | Walking skeleton and seeded truth | `complete` | Seeded D1 returns the golden invoice totals; skeleton deploys |
| 2 | Deterministic domain engine | `complete` | All PRD §20.4 facts computed in pure TypeScript, no LLM |
| 3 | Tool layer | `complete` | Golden investigation runs end to end through 9 tools, no model |
| 4 | Agent | `complete` | Agent cannot declare correctness without reconciliation or call unknown tools |
| 5 | UI and submission | `complete` | Manual golden flow passes on the deployed URL and survives refresh |

---

## Technical spikes

Resolve before or during Milestone 1. Record every outcome in `ARCHITECTURE.md`.

| ID | Question | Timebox | Blocks | Status | Outcome |
|---|---|---|---|---|---|
| S1 | Llama 3.3 multi-turn tool-calling fidelity | 4h | M4 | `complete` | Works via `generateText`. **`streamText` is broken** — see the provider defect below |
| S2 | Structured output via `response_format` | 3h | M4 | `pending` | — |
| S3 | Agents SDK API shape and version pin | 4h | M4 | `complete` | `agents@0.22.0`; `AIChatAgent` from `@cloudflare/ai-chat`; `workers-ai-provider` + `ai` v6 `streamText` |
| S4 | DO SQLite class + state strategy | 2h | M1 | `complete` | `new_sqlite_classes`; runtime reports `use_sqlite: true` |
| S5 | Test harness with D1/DO bindings | 4h | M2, M3 | `complete` | `cloudflareTest()` plugin (not `defineWorkersConfig`), vitest `^4.1.0`, `remoteBindings: false` |
| S6 | 24k context budget | 2h | M4 | `pending` | `maxOutputTokens` set explicitly at 1024 in `src/server.ts` |

---

## PRD §24 definition of done

- [ ] Application is deployed and reachable
- [ ] Workers AI uses Llama 3.3 by default
- [ ] Agents SDK / Durable Object preserves session state
- [ ] D1 contains reproducible synthetic data
- [ ] Suggested prompt launches the complete golden investigation
- [ ] The agent calls bounded, typed, read-only tools
- [ ] Financial calculations are deterministic and tested
- [ ] The $4,820 variance is explained completely and correctly
- [ ] August 14 and `dep-1842` are identified as correlated
- [ ] Price is correctly reported as unchanged
- [ ] Duplicate check returns none
- [ ] Reconciliation passes at every boundary
- [ ] The final confidence is High
- [ ] Evidence is visible for every material claim
- [ ] Refresh restores the investigation
- [ ] Follow-up questions use persisted context
- [ ] No chain-of-thought is shown
- [ ] Synthetic data is clearly disclosed
- [ ] Tests, lint, typecheck, and build pass
- [ ] README, architecture, and prompt history are complete
- [ ] Repository and client bundle contain no credentials

---

## Golden fact regression

Asserted by `test/unit/golden.spec.ts` and printed by `npm run golden`. Any drift
is a build failure, not a test to update.

| Fact | Expected | Verified |
|---|---|---|
| `current_total_cents` | `2172000` | `domain` |
| `comparison_total_cents` | `1690000` | `domain` |
| `variance_cents` | `482000` | `domain` |
| `percentage_variance_display` | `28.5` | `domain` |
| `workers_variance_cents` | `464000` | `domain` |
| `workers_ai_variance_cents` | `18000` | `domain` |
| `price_changed` | `false` | `domain` |
| `change_date` | `2026-08-14` | `domain` |
| `correlated_event_id` | `dep-1842` | `domain` |
| `exact_duplicate_count` | `0` | `domain` |
| `probable_duplicate_count` | `0` | `domain` |
| `reconciliation_status` | `passed` | `domain` |
| `explained_percent` | `100` | `domain` + `tools` + `agent` |
| `confidence` | `high` | `domain` + `tools` + `agent` |

`domain` is pure TypeScript; `tools` is the nine tools against D1; `agent` is the
full bounded loop. Tests assert all three paths produce identical blocks, so a
repository that reshaped data, or an agent that dropped a step, fails rather than
passing quietly.

---

## Milestone 3 — typed investigation tools

Complete. 195 tests across 11 files; typecheck, lint and build green.

**Repositories** (`src/repositories/`): account, usage, pricing, invoice and
event access, every query a prepared statement. Optional filters use fixed
statement variants rather than concatenation, and `get_account_events` filters
types in code instead of building a dynamic `IN` list.

**Tools** (`src/tools/`): all nine from PRD §11. A `createTool` wrapper applies
input parsing, account-scope enforcement and safe error mapping in one place, so
none of the nine can forget one. Every result carries `tool`, `executedAt`,
`sourceRecordIds`, `evidence` and `dataLimitations`.

**Registry** (`src/tools/registry.ts`): the allowlist plus `ToolRunner`, which
caches identical calls within an investigation (FR-5). Failures are not cached,
so a transient error stays retryable. Argument order does not create a second
cache entry.

**Runner** (`src/tools/investigationRunner.ts`): executes the nine-step playbook
against D1 with no model. `npm run investigate` runs it.

### What the tool tests actually prove

- Each of the nine is checked for envelope completeness, evidence-card shape,
  missing/unparseable input, cross-account denial, injection-shaped input, and
  error messages that leak no SQL — driven off the allowlist, so a tenth tool
  cannot be added without being covered.
- `test/unit/sqlSafety.spec.ts` is a static check: only ALL-CAPS column
  constants may be interpolated into a `prepare()` template, the tool layer
  contains no SQL at all, and the read path contains no write statement. It is
  scoped to the `prepare()` argument, since interpolating a *bind value* such as
  `` `${period}-%` `` is safe. Verified to fail on an injected
  `${accountId}` in SQL text.
- The golden run through D1 is asserted to equal the pure-domain block exactly.

### Model tool surface deliberately unchanged

All nine tools exist and are allowlisted, but `buildTools()` still exposes only
`get_account_context` to the model. Handing this model nine tools without the
bounded loop and playbook invites the retry loop seen in M1. The registry is the
seam M4 opens; the deployed demo is unaffected.

---

## Milestone 4 — bounded invoice-variance agent

Complete. 231 tests across 13 files; typecheck, lint and build green. Verified
live against Workers AI, not only under mocks.

### How the split is enforced

The model never calls a tool. It is reached only through `ModelClient`, which
exposes exactly three operations — classify, plan, explain — and the server does
everything else. That is what makes the "may / may not" list structural rather
than a matter of prompt compliance:

| Guarantee | Enforced by |
|---|---|
| Cannot calculate totals | Facts are folded from tool output only (`tools/facts.ts`); model prose never reaches them |
| Cannot run SQL | It has no tool access at all; the server builds every tool input from the record |
| Cannot skip reconciliation | `reconcile_invoice` is called outside the planning loop, and the state machine has no `investigating -> completed` edge |
| Cannot change confidence | `evaluateConfidence` runs after the loop, from facts |
| Cannot widen scope | Model-supplied `accountId` is ignored; periods must be ones D1 returned |
| Cannot invent tools | Selections are filtered against the conditional allowlist |

Limits are hard: 12 tool calls and 4 planning cycles per turn, one retry and
only for a failure the tool marked retryable. The golden path uses 9 calls.

Every model call has a deterministic fallback, so a failing or unavailable model
degrades the answer's prose but never its correctness. A test drives the entire
investigation with `DeterministicModelClient` and still produces the §20.4 block.

### Two defects found by running it live

Both were invisible to the mocked tests, which is the argument for running it.

1. **The model wrote its own Assessment and Recommended next step**, and its
   version ("no further investigation is required") contradicted the computed
   recommendation sitting directly beneath it. The explain prompt now asks for
   the finding sentence only, and `usableFinding()` discards prose that writes
   those sections anyway.

2. **Follow-ups reused the summary prompt**, so "could the usage have been
   duplicated?" got a restatement of the variance instead of an answer.
   `ExplainInput.mode` now separates the two, and follow-ups receive the
   evidence cards rather than only the fact block.

A third, in the UI: `sendMessage` silently drops the message when the socket is
not yet open, while the composer stayed enabled. Controls are now gated on
`connected`.

A fourth, reported against the deployed build: **Reset did not start a new
investigation.** `clearHistory()` deletes the chat messages but does not touch
this agent's `setState` record, so the investigation stayed `completed` and every
later question was routed down the follow-up path — a short answer with no plan
and no structured summary. Behind it sat a latent crash: handing a terminal
record back to the loop would have thrown an opaque transition error, since the
state machine has no edge out of `completed`.

Fixed on both sides. The agent treats the first user message of a conversation
as a new investigation, and `runInvestigationTurn` now rejects a terminal record
with a message that says what to do instead. Two regression tests cover it.

### Persistence

`setState` holds the investigation record — plan, step status, hypotheses,
evidence, facts, summary, metrics — which is what the UI syncs and what survives
refresh. Bulk tool-execution rows go to the Durable Object's `this.sql` as an
audit trail. Model reasoning is persisted in neither: `PlanUpdate.reason` is
read and dropped, and a test asserts it never appears in the serialised record.

### Known limitation: zone attribution

`get_usage_timeseries` reports the zone split of the period's usage (83% primary
in August), not of the *increase* (~97%). A single-period series cannot show the
latter. "Which zone generated the increase?" is therefore answerable only
approximately; closing it properly needs a second series call or a per-zone
change point.

---

## Open decisions

| Decision | Resolved by | Status |
|---|---|---|
| Subclass `AIChatAgent` vs `Agent` | S3 | `AIChatAgent` — free DO-backed message persistence |
| Raw `env.AI.run` vs `workers-ai-provider` + `ai` SDK | S3 | `workers-ai-provider` + `ai` v6 `streamText` |
| Investigation state in `setState()` vs `this.sql` | S4 | `setState` for the record, `this.sql` for the tool-execution audit trail |
| Golden E2E in Workers pool vs Node-side driver | S5 | Workers pool; D1 bindings declared in `vitest.config.ts` |

---

## Milestone 1 — smoke test detail

| Objective | Status | Evidence |
|---|---|---|
| Scaffold current Agents starter | `complete` | `agents@0.22.0`, conventions taken from `cloudflare/agents-starter` |
| Workers AI binding | `complete` | `wrangler.jsonc` `ai.binding = AI`; generated `Env.AI: Ai` |
| Llama 3.3 configured | `complete` | `vars.MODEL_ID`, non-secret, read in `src/server.ts` |
| Agents SDK / DO session | `complete` | DO namespace live, `use_sqlite: true`, WS upgrade accepted |
| D1 binding | `complete` | `Env.DB: D1Database`; explorer lists `DB` |
| Accounts migration | `complete` | `migrations/0001_accounts.sql` applied locally |
| Seed `abc123` | `complete` | `SELECT` returns Acme Corp. / Synthetic Enterprise / USD |
| `get_account_context` tool | `complete` | 10 contract tests pass in workerd against real D1 |
| Minimal chat page | `complete` | Answers correctly from one tool call (see below) |
| Persist across refresh | `complete` | Full exchange restored from the DO after reload |
| One tool contract test | `complete` | `test/integration/getAccountContext.spec.ts`, 10 passing |
| Typecheck / lint / test / build | `complete` | All four green |

Smoke test result, live against Workers AI:

> **You:** What account am I investigating?
> **Agent:** *Called get_account_context* — The account being investigated is
> "Acme Corp." with account ID "abc123". It is a Synthetic Enterprise plan, using
> USD as its currency, and is tax exempt. The primary zone is "api.acme.example"
> and the account has no available invoices.

Every fact traces to the seeded D1 row, and the agent reported "no available
invoices" from `dataLimitations` rather than inventing any.

### Provider defect: `streamText` corrupts tool-call arguments

Under `workers-ai-provider@3.3.1` with `ai@6.0.280`, streamed tool-call argument
deltas are **appended rather than replaced**, so arguments arrive doubled and
interleaved:

```
{"accountId": "{"accountId": "abcabc123"}123"}
```

That fails JSON parsing, so the tool never executes, no result is fed back, and
the model retries until it hits the step limit — five tool calls and no answer.
The same request through `generateText` produces a clean
`{"accountId": "abc123"}` and a correct answer in two steps.

**Workaround in place:** `src/server.ts` uses `generateText` and emits a
`createUIMessageStream` response. This matches the P0 decision in
`BUILD_PLAN.md` §1.2 to cut token-level streaming, so it costs nothing.

**Why not upgrade:** `workers-ai-provider@4.0.0` requires `ai@^7`, while
`@cloudflare/ai-chat@0.9.4` pins `ai@6`. Re-evaluate when `@cloudflare/ai-chat`
moves to `ai@7`.

### Deployment

D1 database `billing-investigator` created
(`01b1a493-7a9e-4787-ae40-daf3be4668b1`, region WNAM), migrated and seeded
remotely. Deployed to https://billing-investigator.om-bhatt.workers.dev with all
four bindings attached: `BillingInvestigatorAgent` (DO), `DB` (D1), `AI`,
`MODEL_ID`.

Smoke test re-verified against the deployed URL: one tool call, correct answer
from remote D1, and state restored after reload.

> The deployed URL is public and unauthenticated. Anyone with the link can chat
> and consume Workers AI quota. All data is synthetic.

---

## Milestone 2 — deterministic domain engine

Complete. 109 tests pass in 9 files; typecheck, lint and build are green.

**Schema.** `migrations/0002_billing_schema.sql` adds the remaining nine P0
tables with foreign keys and the indexes PRD §14 calls for. Investigation state
is deliberately absent from D1: the agent's Durable Object owns it, so the
tables PRD §14 lists as optional are not needed.

**Seed.** `seed/generateSyntheticData.ts` is seeded (`SEED = 20260909`) and
reproducible — a test asserts two runs emit byte-identical SQL. Hourly Workers
events across two zones plus daily Workers AI events: 4,508 events, 276 daily
rows, 3 invoices, 15 lines. Monthly totals are hit exactly by distributing each
month's target across weighted slots and giving the remainder to the last slot,
so the shape can change without the totals drifting.

**Verified against D1**, not just in memory: migration applied and the generated
SQL loaded locally, `invoices` returning 1690000 and 2172000 cents.

### Change-point detection: a documented refinement

PRD §12.7's median-window scan alone does **not** uniquely identify August 14 on
this data. A five-day post-window still reads as shifted when only three of its
days are, so the window medians tie across August 12-16 and the winner comes
down to jitter.

The implementation keeps the prescribed median comparison and adds an onset
rule: a candidate qualifies only when the day itself is in the new regime
(≥ 1.5× the pre-window median) and the day before it is not. That selects the
date the shift *began*, which is what the question asks, and makes August 14 the
unique answer. If no candidate qualifies, it falls back to the largest median
change with `material: false`. A test asserts the neighbours are not selected.

### Rounding order

Each service's monthly charge is rounded to the nearest cent, half up, before
any summation (PRD §12.2). `rateCents` does the multiply in `BigInt` and rounds
with integer arithmetic only, so no currency value ever passes through a float.

---

## Milestone 5 — demo interface and deployment readiness

Complete. 233 tests; typecheck, lint and build green. Verified in a browser.

**UI** (`src/ui/`): masthead with synthetic badge, connection state and Reset
demo; account header (id, name, plan, currency, tax, primary zone, invoices,
from `GET /api/accounts/:id`); two-column 55/45 layout; conversation with
friendly step names; Plan / Evidence / Summary tabs.

- **Plan** — every playbook step with status, the tool that ran, whether it was
  required, and a one-line factual outcome. Plus hypothesis states. No model
  reasoning is persisted, so there is nothing here that could leak it.
- **Evidence** — cards carrying all six PRD §8.3 fields: label, value, source
  tool, record IDs, period, status.
- **Summary** — verdict, confidence badge, fact grid, evidence, assessment,
  outstanding blockers, next step, and whether the wording came from the model
  or the deterministic fallback.

**Verified in the browser, not only reasoned about:**

| Check | Result |
|---|---|
| Two-column ratio at 1440px | `745.797px 610.203px` ≈ 55/45 |
| Horizontal overflow | none |
| Narrow breakpoint | `@media (max-width: 940px)` stacks to `1fr` |
| Dark mode / reduced motion | both media rules present |
| Tablist ARIA | labelled, roving tabindex, `aria-selected`, `aria-controls`, labelled panel |
| Keyboard | ArrowRight Plan→Evidence, End→Summary; focus and selection stay in sync |
| Refresh | plan, evidence, summary and tab counts all restored |
| Reset demo vs seed data | row counts, invoice totals and total quantity **identical** before and after |

**Docs:** `README.md` and `ARCHITECTURE.md` written; exact local and Cloudflare
deployment commands included in both the README and the final report.

### Known gaps carried into later milestones

- ~~The model infers `abc123` from a `.describe()` example.~~ Resolved in M4: the
  server builds every tool input from the investigation record, and a
  model-supplied account id is ignored.
- `SESSION_NAME` in `src/app.tsx` is still a fixed constant, so every visitor to
  the deployed URL shares one investigation. M5 should key it per investigation.
- The UI still renders one message column. Plan, Evidence and Summary tabs
  (PRD §8.1) are M5; the data they need is already on the synced record.

---

## Log

| Date | Entry |
|---|---|
| 2026-09-09 | PRD reviewed. `BUILD_PLAN.md`, `CLAUDE.md`, `BUILD_STATUS.md` created. No code written. Committed `efd5b58`. |
| 2026-09-09 | M1 built. Spikes S3/S4/S5 resolved against the real SDK — several documented APIs had moved. All four gates green. Live chat blocked on Cloudflare auth. |
| 2026-09-09 | `wrangler login` + workers.dev subdomain unblocked dev. Smoke test passes: one tool call, correct answer, state restored after refresh, reset works. Found and worked around a `workers-ai-provider` streaming defect (S1). |
| 2026-09-09 | M2 complete. Full P0 schema, reproducible seed, eight domain modules, 109 tests. Every PRD §20.4 fact computed with no LLM. Change-point detection needed a documented onset rule to land on Aug 14 uniquely. |
| 2026-09-09 | M3 complete. Five repositories, nine tools, allowlist + caching runner, 195 tests. Golden block re-proven through D1 and asserted identical to the domain path. Model tool surface left at one tool until M4's bounded loop exists. |
| 2026-09-09 | M4 complete. Bounded agent behind a three-method ModelClient seam, state machine, server-side completion, deterministic confidence, 231 tests. Verified live; live runs exposed two defects the mocks could not (model authoring its own assessment, follow-ups reusing the summary prompt). |
| 2026-09-09 | M4 deployed to production. User reported questions returning no plan or summary; root cause was `clearHistory()` not clearing the investigation record, so Reset could not start a new case. Fixed, redeployed, 233 tests. |
| 2026-09-09 | M5 complete. Two-column UI with Plan/Evidence/Summary tabs, account header endpoint, full state handling, README and ARCHITECTURE. Layout, keyboard, refresh and Reset-vs-seed-data all verified in a browser. P0 done. |
| 2026-09-10 | External code review, findings 1–8 addressed in order. Each fix mutation-checked; ARCHITECTURE.md §9–§16 records the reasoning. 353 tests, up from 233. Golden facts unchanged throughout. |
| 2026-09-10 | Finding 9: clarification replies were never reclassified, so a correct answer ended `unresolved`; unavailable periods were silently swapped for the newest invoice. Both fixed, 361 tests. |
| 2026-09-10 | Finding 9 post-deploy: production showed the live model clamps unavailable periods itself, and prose then mislabelled the months while every figure stayed real. Question text now validated before the model runs; narrative guard now checks which periods an answer claims to be about. 378 tests. |
| 2026-09-10 | Finding 10: a scan candidate was returned as a detected change point, so flat usage produced a confirmed shift and a spurious event correlation. Detection is now an acceptance; materiality and confidence travel with the date on all three paths. 394 tests. |
| 2026-09-10 | Finding 11: the required zone-growth follow-up had only current-period zone shares to work from (83% of the period vs 96% of the growth). Per-zone comparison now computed in the domain and persisted during the investigation. 410 tests. P0 review findings 1-11 all closed. |
