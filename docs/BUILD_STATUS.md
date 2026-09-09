# Build Status

Tracks execution of `docs/BUILD_PLAN.md`. Update this file as part of every milestone-advancing
change — a stale status file is a defect.

**Last updated:** 2026-09-09
**Phase:** Milestone 1 complete and deployed. Milestone 2 not started.

**Deployed:** https://billing-investigator.om-bhatt.workers.dev

**Status values:** `pending` · `in_progress` · `blocked` · `complete`

---

## Milestones

| # | Milestone | Status | Exit criterion |
|---|---|---|---|
| 1 | Walking skeleton and seeded truth | `complete` | Seeded D1 returns the golden invoice totals; skeleton deploys |
| 2 | Deterministic domain engine | `pending` | All PRD §20.4 facts computed in pure TypeScript, no LLM |
| 3 | Tool layer | `pending` | Golden investigation runs end to end through 9 tools, no model |
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

Asserted by `test/e2e/golden.spec.ts`. Any drift is a build failure, not a test to update.

| Fact | Expected | Verified |
|---|---|---|
| `current_total_cents` | `2172000` | `pending` |
| `comparison_total_cents` | `1690000` | `pending` |
| `variance_cents` | `482000` | `pending` |
| `workers_variance_cents` | `464000` | `pending` |
| `workers_ai_variance_cents` | `18000` | `pending` |
| `price_changed` | `false` | `pending` |
| `change_date` | `2026-08-14` | `pending` |
| `correlated_event_id` | `dep-1842` | `pending` |
| `exact_duplicate_count` | `0` | `pending` |
| `probable_duplicate_count` | `0` | `pending` |
| `reconciliation_status` | `passed` | `pending` |
| `explained_percent` | `100` | `pending` |
| `confidence` | `high` | `pending` |

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
