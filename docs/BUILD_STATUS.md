# Build Status

Tracks execution of `docs/BUILD_PLAN.md`. Update this file as part of every milestone-advancing
change — a stale status file is a defect.

**Last updated:** 2026-09-09
**Phase:** Milestones 1-3 complete. Milestone 4 (agent) not started.

**Deployed:** https://billing-investigator.om-bhatt.workers.dev

**Status values:** `pending` · `in_progress` · `blocked` · `complete`

---

## Milestones

| # | Milestone | Status | Exit criterion |
|---|---|---|---|
| 1 | Walking skeleton and seeded truth | `complete` | Seeded D1 returns the golden invoice totals; skeleton deploys |
| 2 | Deterministic domain engine | `complete` | All PRD §20.4 facts computed in pure TypeScript, no LLM |
| 3 | Tool layer | `complete` | Golden investigation runs end to end through 9 tools, no model |
| 4 | Agent | `pending` | Agent cannot declare correctness without reconciliation or call unknown tools |
| 5 | UI and submission | `pending` | Manual golden flow passes on the deployed URL and survives refresh |

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
| `explained_percent` | `100` | `domain` + `tools` |
| `confidence` | `high` | `domain` + `tools` |

`domain` means proven in pure TypeScript; `tools` means re-proven by running the
nine tools against D1. A test asserts the two paths produce identical blocks, so
a repository that reshaped or dropped data would fail rather than pass quietly.
M4 adds the agent path.

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

## Open decisions

| Decision | Resolved by | Status |
|---|---|---|
| Subclass `AIChatAgent` vs `Agent` | S3 | `AIChatAgent` — free DO-backed message persistence |
| Raw `env.AI.run` vs `workers-ai-provider` + `ai` SDK | S3 | `workers-ai-provider` + `ai` v6 `streamText` |
| Investigation state in `setState()` vs `this.sql` | S4 | open — not needed until M4 |
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

### Known gaps carried into later milestones

- The model currently infers `abc123` from the `.describe()` example on the tool
  schema. M4 must inject the investigation's account id explicitly instead of
  relying on that.
- `SESSION_NAME` in `src/app.tsx` is a fixed constant, so every visitor shares
  one investigation. M4 replaces it with a real investigation id.

---

## Log

| Date | Entry |
|---|---|
| 2026-09-09 | PRD reviewed. `BUILD_PLAN.md`, `CLAUDE.md`, `BUILD_STATUS.md` created. No code written. Committed `efd5b58`. |
| 2026-09-09 | M1 built. Spikes S3/S4/S5 resolved against the real SDK — several documented APIs had moved. All four gates green. Live chat blocked on Cloudflare auth. |
| 2026-09-09 | `wrangler login` + workers.dev subdomain unblocked dev. Smoke test passes: one tool call, correct answer, state restored after refresh, reset works. Found and worked around a `workers-ai-provider` streaming defect (S1). |
| 2026-09-09 | M2 complete. Full P0 schema, reproducible seed, eight domain modules, 109 tests. Every PRD §20.4 fact computed with no LLM. Change-point detection needed a documented onset rule to land on Aug 14 uniquely. |
| 2026-09-09 | M3 complete. Five repositories, nine tools, allowlist + caching runner, 195 tests. Golden block re-proven through D1 and asserted identical to the domain path. Model tool surface left at one tool until M4's bounded loop exists. |
