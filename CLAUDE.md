# Billing Investigator — Project Rules

Read-only AI agent that investigates invoice-variance complaints over synthetic billing data.
Source of truth: `docs/PRD.md`. Build order: `docs/BUILD_PLAN.md`. Progress:
`docs/BUILD_STATUS.md`.

## Commands

```bash
npm install
npm run dev                  # local worker + UI
npm run db:migrate:local     # apply migrations to local D1
npm run db:seed:local        # regenerate + load deterministic synthetic seed
npm run seed:build           # write .seed/golden.sql without loading it
npm run golden               # golden fact block from pure domain code (add -- --full)
npm run investigate          # same block, run through the nine tools against D1
npm run test:unit            # pure domain, plain Node, no runtime
npm run test:integration     # tools + agent, Workers pool
npm test                     # all
npm run typecheck && npm run lint && npm run build
npm run deploy
```

## Architecture boundaries

```
React UI  ->  Worker routing  ->  BillingInvestigatorAgent (Durable Object)
                                    |-- Workers AI (Llama 3.3)
                                    |-- allowlisted read-only tools
                                    |-- durable investigation state
                                  D1 (synthetic billing data)
```

| Layer | Owns | Must never |
|---|---|---|
| `src/domain/` | Money, rating, variance, change point, duplicates, reconciliation | Import D1, Workers AI, or any runtime binding |
| `src/repositories/` | Prepared-statement D1 access | Interpolate strings into SQL |
| `src/tools/` | Typed read-only tool handlers, validation, account scoping | Write SQL, or accept SQL/URLs/paths from the model |
| `src/agent/` | Classification, playbook, bounded loop, explanation | Compute authoritative money |
| `src/ui/` | Question, progress, evidence, summary | Show chain-of-thought |

`src/domain/` must be testable in plain Node with zero Cloudflare imports. This is what makes
the financial logic provable.

## Permanent rules

1. **Deterministic money, probabilistic language.** All currency and quantity math runs in
   `src/domain/`. The LLM explains results; it never calculates them.
2. **Integer cents everywhere**, as branded `Cents` (`src/domain/units.ts`). Construct at the
   repository boundary; combine only via checked ops. Format to USD only for display.
3. **Read-only, always.** No writes to billing data. No payments, refunds, credits, or invoice
   corrections at any priority.
4. **Tool allowlist is server-enforced.** `src/tools/catalog.ts` is the single source of truth,
   and carries each tool’s types. Unknown names are rejected. The model never sees D1.
5. **Account scoping is enforced per call.** A tool may only read the account bound to the
   current investigation.
6. **Evidence before conclusion.** Every material claim links to a tool result and source
   record IDs.
7. **Never claim correctness without reconciliation.** "Appears correct" requires a passing
   reconciliation, ≥95% variance explained, and no unresolved material discrepancy.
8. **Correlation is not causation.** Temporal proximity is reported as `correlated`, never as
   proven cause.
9. **Confidence is deterministic.** Computed by `src/domain/confidence.ts`. The LLM may explain
   it; it may not change it.
10. **Bounded loop.** Max 12 tool calls per user turn, 4 planning cycles, 1 retry on transient
    failure. No subagents.
11. **Never expose chain-of-thought.** Show plan steps, tool names as friendly actions, and
    evidence only.
12. **No fabrication.** No invented records, amounts, IDs, dates, tools, or tool results. Missing
    or conflicting evidence means `unresolved`.
13. **Seed is reproducible.** Fixed seed, byte-identical output across runs. Never store the
    expected textual conclusion in seed data.
14. **All data is synthetic and disclosed** in the landing view, the footer, and the README.
15. **Model ID is configurable** via a non-secret env var, defaulting to
    `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
16. **Context is scarce** — the model window is 24,000 tokens. Tools return compact aggregates.
    Full time series reach the UI as structured evidence and never enter the prompt. Always set
    `max_tokens` explicitly; the default is 256.
17. **No secrets** in the repo, logs, or client bundle. Never log complete prompts.
18. **Errors are safe.** Stable machine code + safe message. Never return stack traces, prompts,
    or raw database errors to the browser.
19. **Update `PROMPT_HISTORY.md`** as work proceeds — it is a submission requirement.
20. **Record deviations from the PRD** in `ARCHITECTURE.md`, with rationale.

## Review invariants — earned from defects, mutation-checked, do not regress

Findings and design reviews, one shape: a guarantee checked in the present-and-wrong case but
not the absent one. Reasoning per item is in `ARCHITECTURE.md` §9–§24.

21. **Absence is not proof, and a candidate is not a finding.** A check whose inputs are gone
    has not run; a scan's best row is not a detection. Covers unchecked duplicates, unperformed
    diagnostics, unverified fixed fees, a gutted reconciliation, and flat usage "shifting".
22. **Overlap is not coverage.** A price version must span a whole period to rate it. Partial
    coverage is a gap; two versions are a price change; neither may silently rate.
23. **Answer the question asked.** A per-service finding never becomes invoice-wide; facts
    accumulate, never overwrite. Periods the account lacks are reported, never substituted, and
    a clarification reply is reclassified against the request it answers.
24. **Required diagnostics are run, not requested.** The server backstops anything the playbook
    marks applicable. Never rely on the model selecting a mandatory check.
25. **Prose is bounded by evidence.** Narrative may only use amounts, ids, dates, percentages
    and periods appearing in facts or evidence — naming an uninvestigated month is fabrication
    even when every figure is real. Rejection is all-or-nothing (`src/agent/narrativeGuard.ts`).
26. **Sessions are isolated and server-owned.** Clients never write investigation state; each
    reset advances the generation and a turn commits only into its own; the `useAgent` name is
    the Durable Object id and must never be a shared constant.

## Not in P0 — do not add

Workflows, R2, Vectorize, AI Gateway, auth/RBAC, accounts beyond `abc123`, non-variance cases.

All P1 (more accounts, escalation export, AI Gateway, cost chart) and P2 (production APIs,
approvals, Slack/email, forecasting, contract ingestion, vector search) wait until P0 is done.

> "R2" and "D1" appear as synthetic **invoice line items** in seeded data. The R2 product is not
> used as infrastructure. D1 is required infrastructure.

## Golden facts — must never drift

```
current_total_cents      = 2172000      change_date              = 2026-08-14
comparison_total_cents   = 1690000      correlated_event_id      = dep-1842
variance_cents           = 482000       exact_duplicate_count    = 0
workers_variance_cents   = 464000       probable_duplicate_count = 0
workers_ai_variance_cents= 18000        reconciliation_status    = passed
price_changed            = false        explained_percent        = 100
change_point_material    = true         confidence               = high
change_point_confidence  = high
```

`change_date` is set only for an **accepted** change point; flat usage leaves all three null.

Tests assert these structured facts, never LLM prose.

## Definition of done

A change is done when:

- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all pass
- [ ] New financial logic has unit tests in `test/unit/` and lives in `src/domain/`
- [ ] New tools have contract tests: input validation, required envelope fields, account
      scoping denial, parameterized queries
- [ ] The golden E2E still asserts the fact block above, unchanged
- [ ] No new Cloudflare service was introduced without updating `docs/BUILD_PLAN.md`
- [ ] `docs/BUILD_STATUS.md` reflects reality
- [ ] `PROMPT_HISTORY.md` records the prompt and outcome
- [ ] No secrets in the diff

P0 overall is done only when all twenty-one boxes in PRD §24 are checked and the PRD §20.5
manual acceptance test passes against the deployed URL.
