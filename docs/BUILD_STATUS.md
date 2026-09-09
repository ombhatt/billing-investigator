# Build Status

Tracks execution of `docs/BUILD_PLAN.md`. Update this file as part of every milestone-advancing
change — a stale status file is a defect.

**Last updated:** 2026-09-09
**Phase:** Planning complete. Implementation not started.

**Status values:** `pending` · `in_progress` · `blocked` · `complete`

---

## Milestones

| # | Milestone | Status | Exit criterion |
|---|---|---|---|
| 1 | Walking skeleton and seeded truth | `pending` | Seeded D1 returns the golden invoice totals; skeleton deploys |
| 2 | Deterministic domain engine | `pending` | All PRD §20.4 facts computed in pure TypeScript, no LLM |
| 3 | Tool layer | `pending` | Golden investigation runs end to end through 9 tools, no model |
| 4 | Agent | `pending` | Agent cannot declare correctness without reconciliation or call unknown tools |
| 5 | UI and submission | `pending` | Manual golden flow passes on the deployed URL and survives refresh |

---

## Technical spikes

Resolve before or during Milestone 1. Record every outcome in `ARCHITECTURE.md`.

| ID | Question | Timebox | Blocks | Status | Outcome |
|---|---|---|---|---|---|
| S1 | Llama 3.3 multi-turn tool-calling fidelity | 4h | M4 | `pending` | — |
| S2 | Structured output via `response_format` | 3h | M4 | `pending` | — |
| S3 | Agents SDK API shape and version pin | 4h | M4 | `pending` | — |
| S4 | DO SQLite class + state strategy | 2h | M1 | `pending` | — |
| S5 | Test harness with D1/DO bindings | 4h | M2, M3 | `pending` | — |
| S6 | 24k context budget | 2h | M4 | `pending` | — |

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
| Subclass `AIChatAgent` vs `Agent` | S3 | open |
| Raw `env.AI.run` vs `workers-ai-provider` + `ai` SDK | S3 | open |
| Investigation state in `setState()` vs `this.sql` | S4 | open |
| Golden E2E in Workers pool vs Node-side driver | S5 | open |

---

## Log

| Date | Entry |
|---|---|
| 2026-09-09 | PRD reviewed. `BUILD_PLAN.md`, `CLAUDE.md`, `BUILD_STATUS.md` created. No code written. |
