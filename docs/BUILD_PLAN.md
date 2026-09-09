# Build Plan — P0 (Smallest Credible Build)

**Derived from:** `docs/PRD.md` v1.0
**Status:** Plan only. No implementation has started.
**Companion docs:** `CLAUDE.md` (permanent rules), `docs/BUILD_STATUS.md` (progress tracker)

---

## Context

The PRD specifies a full Billing Investigator product with three case types' worth of
supporting machinery, multiple accounts, exports, charts, and observability integrations
spread across P0/P1/P2. Building it breadth-first would produce a shallow demo that fails
its own definition of done.

This plan reduces the PRD to the **smallest build that is still credible** — the narrowest
slice that can honestly satisfy every P0 checkbox in PRD §24. The bet is the one stated in
PRD §28: *build the narrow P0 deeply*. One account, one case type, one invoice pair, nine
tools, proven correct to the cent.

The reduction is driven by a single test: **does cutting this break a §24 DoD checkbox or a
§20.4 golden assertion?** If no, it is cut. Everything retained below is load-bearing.

**Intended outcome:** a reviewer clones the repo, runs four documented commands, asks one
question, and watches a bounded agent explain 100% of a $4,820 variance with visible
evidence and a reconciliation that passes to the cent — then refreshes the page and finds
the investigation intact.

---

## 1. P0 scope lock

### 1.1 In scope

| Area | P0 commitment |
|---|---|
| Accounts | `abc123` / Acme Corp. **only** |
| Case type | `invoice_variance` **only** |
| Periods | Compare 2026-07 vs 2026-08. Seed 2026-06 for baseline. |
| Services | Platform fee, Workers, Workers AI, R2, D1 — as **invoice data rows** |
| Tools | 9 read-only typed tools (§1.3) |
| Model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI binding |
| State | Cloudflare Agents SDK, Durable Object-backed |
| Data | D1, migrations + reproducible deterministic seed |
| UI | Two-column; Plan / Evidence / Summary tabs |
| Tests | Unit, tool-contract, mocked-agent integration, golden E2E |

> **Note on "R2" and "D1" in the table above:** these appear as *synthetic invoice line
> items* in seeded billing data. The R2 **product** is not used as infrastructure. D1 **is**
> used as infrastructure, and is required.

### 1.2 Cut from PRD P0 (with rationale)

| Cut | Rationale |
|---|---|
| `get_evidence_details` tool (PRD §11.10) | Evidence already lives in durable agent state and is in-context for follow-ups. A tool round-trip adds an authorization surface for zero user-visible gain. Documented as a deviation in `ARCHITECTURE.md`. |
| Token-level response streaming | PRD §8.2 makes streaming conditional ("if supported by the selected SDK path"). P0 pushes **live plan-step status** via agent state sync, then renders the final message whole. Feels live, removes an entire failure mode. |
| Multi-tier rate computation | PRD §12.3 explicitly permits fixed fee + one linear overage tier. Schema allows tiers; the engine computes one. |
| Precise sub-daily change timestamp in UI | PRD §13.7 makes this optional ("where supported"). P0 detects the **daily** change point (2026-08-14) and correlates events within ±24h. Raw event timestamps stay seeded for a P1 upgrade. |

### 1.3 The nine tools

All read-only, typed input, prepared D1 statements, scoped to the investigation's account.

```
get_account_context        detect_usage_change_point
compare_invoices           get_account_events
decompose_variance         check_duplicate_usage
get_usage_timeseries       reconcile_invoice
get_price_versions
```

Each returns the PRD §11 envelope: `tool`, `executedAt`, `sourceRecordIds`, `evidence`,
`dataLimitations`.

---

## 2. Explicit exclusions

### 2.1 Banned infrastructure in P0

Not used, not configured, not referenced in `wrangler.jsonc`:

- **Cloudflare Workflows** — the Agents SDK Durable Object is the single source of truth for
  investigation state. Adding Workflows creates state-ownership ambiguity (PRD §15.4).
- **R2** (as infrastructure) — no object storage requirement exists in P0.
- **Vectorize** — no retrieval requirement. Policy/contract vector search is P2 (PRD §6.3).
- **AI Gateway** — P1 (PRD §6.2). P0 uses structured logging for observability.
- **Authentication / RBAC / multi-tenancy** — explicit non-goal (PRD §4.2). The demo user is
  a trusted internal operator.
- **Additional accounts** — `abc123` only.

### 2.2 P1 — not built

Second account (missing-credit), third account (duplicated usage), escalation-summary
export/copy, AI Gateway inference observability, cost-driver chart.

### 2.3 P2 — not built

Production API integration, human approval for financial adjustments, Slack/email channels,
forecasting, enterprise contract ingestion, automated case creation, vector search over
policies or contracts.

### 2.4 Permanent prohibitions (any priority)

Write operations of any kind, payment processing, refunds, invoice corrections, LLM-authored
SQL, LLM-computed authoritative financial totals.

---

## 3. Milestones

Five milestones. Each is independently verifiable — it has a check that passes or fails
without depending on work from a later milestone.

---

### Milestone 1 — Walking skeleton and seeded truth

**Goal:** A deployed, empty-but-real application with a reproducible D1 database that
contains the exact golden numbers.

Deploying at M1 rather than M5 de-risks the submission: the first deploy happens when there
is nothing to debug but configuration.

**Files / components to create**

```
wrangler.jsonc                        bindings: AI, D1, Agent DO namespace
package.json, tsconfig.json, vitest.config.ts
migrations/0001_init.sql              accounts, zones, subscriptions, price_versions,
                                      usage_events, daily_usage, rated_charges,
                                      invoices, invoice_lines, account_events
migrations/0002_investigations.sql    investigations, investigation_steps,
                                      tool_executions, evidence_items
seed/generateSyntheticData.ts         deterministic, fixed-seed generator
seed/run.ts                           emits SQL / applies via wrangler
src/domain/money.ts                   integer-cent primitives
src/index.ts                          Worker entry, health route
```

**Acceptance criteria covered**

- FR-14 (synthetic disclosure scaffolding), PRD §13 (entire data spec), §14 (data model)
- DoD: *D1 contains reproducible synthetic data*
- DoD: *Application is deployed and reachable* (skeleton)

**Tests that must pass**

- `money.ts`: cent arithmetic, half-up rounding, USD formatting at presentation boundary only
- Seed determinism: two runs from the same seed produce byte-identical output
- Seeded July Workers usage sums to exactly `1_000_000_000` requests
- Seeded August Workers usage sums to exactly `1_580_000_000` requests
- August 1–13 daily mean is within tolerance of July's; August 14+ is materially higher
- `dep-1842` exists at `2026-08-14T09:58:00Z` on `zone-api-acme`
- Negative facts hold: zero duplicate event IDs, zero price-version changes in
  2026-07-01 → 2026-08-31, no credit or tax lines on either invoice

**Manual verification**

```bash
npm run db:migrate:local && npm run db:seed:local
npx wrangler d1 execute billing --local \
  --command "SELECT period, total_cents FROM invoices WHERE account_id='abc123'"
# Expect: 2026-07 -> 1690000, 2026-08 -> 2172000
npm run deploy     # skeleton reachable at the workers.dev URL
```

---

### Milestone 2 — Deterministic domain engine

**Goal:** Every golden fact in PRD §20.4 is computable in pure TypeScript, with no LLM, no
HTTP, and no Worker runtime.

This is the milestone that makes the product honest. It must be finished before any model
code exists.

**Files / components to create**

```
src/domain/rating.ts           billable = max(0, consumed - included); fixed fee + 1 tier
src/domain/variance.ts         counterfactual volume/price split, percent explained
src/domain/changePoint.ts      median pre/post window scan (PRD §12.7)
src/domain/duplicates.ts       exact by event_id; probable by 1-minute-bucket fingerprint
src/domain/reconciliation.ts   4 boundaries, zero tolerance
src/domain/confidence.ts       deterministic High/Medium/Low table
src/types/domain.ts
test/unit/*.spec.ts
```

**Acceptance criteria covered**

- FR-6, FR-7, FR-8, FR-9, FR-10; PRD §12 in full
- DoD: *Financial calculations are deterministic and tested*
- DoD: *$4,820 variance explained completely*, *Aug 14 + `dep-1842` correlated*,
  *price unchanged*, *duplicates none*, *reconciliation passes*, *confidence High*

**Tests that must pass** — the full PRD §20.1 list:

| Assertion | Expected |
|---|---|
| Workers July rating | `720_000` cents |
| Workers August rating | `1_184_000` cents |
| Workers variance | `464_000` cents |
| Workers AI variance | `18_000` cents |
| Invoice variance | `482_000` cents |
| Percentage change display | `28.5%` |
| Volume + price effects | sum exactly to total variance |
| Price changed, Jul→Aug | `false` |
| Change-point date | `2026-08-14` |
| Exact / probable duplicates | `0` / `0` |
| All 4 reconciliation boundaries | difference `0` |
| Confidence | `high` |
| Zero comparison total | percentage `null`, no divide-by-zero |
| Unknown account, invalid range | rejected |

**Manual verification**

```bash
npm run test:unit
npx tsx scripts/goldenFacts.ts   # prints the §20.4 block from domain code alone
```
Read the printed block and confirm it matches PRD §20.4 line for line.

---

### Milestone 3 — Tool layer

**Goal:** The complete golden investigation runs end to end through the nine tools, driven by
a test — with no model in the loop.

**Files / components to create**

```
src/repositories/*.ts          prepared-statement D1 access, one per aggregate
src/tools/definitions.ts       JSON-schema tool specs + allowlist (single source of truth)
src/tools/registry.ts          name -> handler, validation, account scoping, result cache
src/tools/<nine tools>.ts
src/tools/envelope.ts          tool / executedAt / sourceRecordIds / evidence / dataLimitations
src/types/tools.ts
test/integration/tools.spec.ts
test/integration/goldenToolRun.spec.ts
```

**Acceptance criteria covered**

- FR-1, FR-5; PRD §11 (all specs), §17 (security controls)
- DoD: *The agent calls bounded, typed, read-only tools*
- DoD: *Evidence is visible for every material claim* (data half)

**Tests that must pass** — PRD §20.2 plus the golden run:

- Every tool rejects malformed input before touching D1
- Every tool returns all documented envelope fields
- A tool called with an account other than the investigation's account is **denied**
- Unknown tool names are rejected by the registry
- Every D1 query is parameterized (assert no string interpolation in query construction)
- An identical repeat call within one investigation returns the cached persisted result
- Unknown account ID returns the safe `404`-shaped error, never raw SQL error text
- **Golden tool run:** sequencing the nine tools produces the complete PRD §20.4 fact block

**Manual verification**

```bash
npm run test:integration
npx tsx scripts/toolRun.ts --account abc123 --current 2026-08 --comparison 2026-07
```
Confirm printed evidence includes `price-workers-2026-01`, `dep-1842`, `2026-08-14`,
`reconciliation_status = passed`, `explained_percent = 100`.

---

### Milestone 4 — Agent

**Goal:** The LLM plans and explains; it can neither compute money nor declare the invoice
correct without a passing reconciliation.

**Files / components to create**

```
src/agent/BillingInvestigatorAgent.ts   Agents SDK class, DO-backed state
src/agent/systemPrompt.ts               versioned, PRD §10.5 semantics
src/agent/playbooks/invoiceVariance.ts  required + conditional steps
src/agent/classify.ts                   structured case classification
src/agent/loop.ts                       bounded tool loop: 12 calls, 4 replans, 1 retry
src/agent/stateMachine.ts               PRD §10.3 states and legal transitions
src/agent/completion.ts                 FR-11 gate
src/agent/fallbackSummary.ts            deterministic summary on LLM synthesis failure
src/agent/logging.ts                    structured events keyed by investigation_id
test/integration/agent.spec.ts          mocked / replayable model layer
test/e2e/golden.spec.ts
```

**Acceptance criteria covered**

- FR-2, FR-3, FR-4, FR-11, FR-12, FR-13; PRD §10 in full, §18, §19 retry/fallback
- DoD: *Agents SDK / Durable Object preserves session state*
- DoD: *No chain-of-thought is shown*, *follow-up questions use persisted context*

**Tests that must pass** — PRD §20.3 and §20.4:

- The golden question classifies as `invoice_variance` with periods `2026-08` / `2026-07`
- Required initial tools are invoked in playbook order
- The usage branch is selected after invoice comparison
- Reconciliation runs **before** any completion
- With reconciliation missing or failed, the agent **cannot** declare correctness
- The agent halts cleanly at the 12-tool-call limit
- Conflicting evidence yields `unresolved`, not a confident answer
- A follow-up ("Could the usage have been duplicated?") reuses persisted evidence and
  triggers no redundant tool call
- Golden E2E asserts the structured §20.4 fact block — **never** LLM prose

**Manual verification**

```bash
npm run dev
```
Ask the golden question against **real** Workers AI. Confirm: correct classification, plan
steps advance, tool calls stay within limits, final structured result matches §20.4. Kill and
restart the dev server, reconnect to the same investigation ID, confirm state restores. Then
force a synthesis failure (temporarily point the model ID at a bad value) and confirm the
deterministic fallback summary renders from completed evidence.

---

### Milestone 5 — UI and submission

**Goal:** A reviewer can run, understand, and demo the project from a clean checkout.

**Files / components to create**

```
src/ui/App.tsx                  two-column responsive shell
src/ui/AccountHeader.tsx        ID, name, plan, currency, Synthetic badge
src/ui/Composer.tsx             suggested prompt, submit lock, Reset demo
src/ui/Conversation.tsx
src/ui/panels/PlanTab.tsx       steps + status + concise outcome
src/ui/panels/EvidenceTab.tsx   PRD §8.3 evidence cards
src/ui/panels/SummaryTab.tsx    finding, confidence, next step
src/ui/states/{Empty,Loading,Error,Unresolved}.tsx
README.md   ARCHITECTURE.md   PROMPT_HISTORY.md
```

**Acceptance criteria covered**

- FR-1, FR-13, FR-14; PRD §8 (UX), §21 (accessibility), §22 (docs)
- DoD: remaining boxes — deployed and reachable, suggested prompt launches the golden
  investigation, refresh restores, synthetic data disclosed, lint/typecheck/build/tests pass,
  README + architecture + prompt history complete, no credentials in repo or client bundle

**Tests that must pass**

- Full suite green: `npm run typecheck && npm run lint && npm test && npm run build`
- Evidence cards render all six required fields (label, value, source, record IDs, period,
  status)
- Status is never communicated by color alone — text or icon always accompanies it
- Secret scan over repo and built client bundle returns clean

**Manual verification** — PRD §20.5, executed literally:

1. Clean checkout; run migrations and seed using only README commands
2. Open the app; run the suggested investigation
3. Inspect every plan step and every evidence card
4. Refresh the page; confirm state restoration
5. Ask "Could the usage have been duplicated?"; confirm the answer references the existing
   duplicate check rather than re-running it
6. Reset the demo; confirm seeded billing data is unchanged
7. Tab through the entire flow with keyboard only
8. Confirm the deployed URL performs identically to local

---

## 4. Technical spikes

Cloudflare SDK and API surfaces have moved. These are resolved **before or during M1**, each
timeboxed, each with a committed fallback so no spike can block the build.

Findings from an initial documentation pass are recorded inline. Every spike outcome goes
into `ARCHITECTURE.md` per the PRD §0 mandate.

### S1 — Llama 3.3 tool-calling loop fidelity · 4h · blocks M4

*Known:* the model page lists **Function calling** as a supported capability, and
`env.AI.run()` accepts a native `tools` array returning `tool_calls`.
*Unknown:* multi-turn reliability — whether tool results fed back as messages produce a clean
follow-up call, argument fidelity against strict JSON schemas, and behavior at the 12-call
bound.
**Exit:** a throwaway script drives 3 sequential tool calls with correct arguments.
**Fallback:** narrow tool schemas to flat primitives; server infers periods rather than
trusting model-extracted arguments.

### S2 — Structured output for classification and plan updates · 3h · blocks M4

*Known:* the model exposes a `response_format` parameter, but its behavior is **undocumented**
for this model.
*Unknown:* whether JSON-schema-constrained output is actually enforced.
**Exit:** 20/20 valid parses of the PRD §10.7 classification schema.
**Fallback:** prompt-constrained JSON + Zod parse + one repair retry + deterministic default
(`invoice_variance`, `abc123`, `2026-08`/`2026-07`). PRD §10.7 already requires the server to
ignore unknown fields and reject unknown tool names, so the fallback is compliant.

### S3 — Agents SDK API shape and version pin · 4h · blocks M4, informs M1

*Known:* package is `agents`; provides `Agent` / `AIChatAgent`, `this.env`, `this.ctx`,
`this.state`, `this.sql`, `setState()`, `onStateChanged()`, lifecycle hooks, and
`routeAgentRequest()`; React side offers `useAgent` / `useAgentChat`. Docs also now reference
a "Fibers" durable-execution primitive.
*Unknown:* whether to subclass `AIChatAgent` (free message persistence and resumable
streaming, less loop control) or `Agent` (full control of the bounded loop); and whether to
call the model via raw `env.AI.run` or via `workers-ai-provider` + the Vercel `ai` SDK.
**Exit:** an exact pinned version in `package.json` and a written decision.
**Bias:** `AIChatAgent` for persistence, with the tool loop **owned by our code** — server-side
allowlisting and the 12-call cap (PRD §10.6) are non-negotiable and must not be delegated to a
library's auto-loop.
**Fallback:** subclass `Agent` and hand-roll message persistence into `this.sql`.

### S4 — Durable Object SQLite class and state strategy · 2h · blocks M1

*Unknown:* current `wrangler.jsonc` migration syntax for the agent DO
(`new_sqlite_classes` vs `new_classes`), and whether investigation state belongs in
`setState()` (JSON, synced to UI, size-capped) or `this.sql`.
**Exit:** `wrangler dev` boots the DO and round-trips state.
**Bias:** small synced state via `setState()` (plan steps, hypothesis statuses, summary — this
is what drives live UI updates); bulky tool results and evidence in `this.sql`.

### S5 — Test harness with D1 and DO bindings · 4h · blocks M2/M3

*Unknown:* whether `@cloudflare/vitest-pool-workers` can apply migrations and seed per-suite
with isolated storage, and whether the golden E2E runs in-worker or needs a Node-side driver.
**Exit:** one test reads a seeded row from D1 inside the Workers pool.
**Fallback:** pure-domain tests run in plain Node against fixtures (M2 needs no runtime at
all — this is deliberate); only tool-contract and E2E tests require the Workers pool.

### S6 — 24k context budget · 2h · blocks M4

*Known:* the model's context window is **24,000 tokens**, and `max_tokens` defaults to **256**.
*Impact:* both are sharp constraints. 24k makes PRD §15.3 ("do not preload three months of raw
usage") a hard requirement rather than a style preference; a 256-token default would silently
truncate the final synthesis.
**Exit:** a measured token budget for system prompt + playbook + compacted evidence across a
9-tool investigation plus two follow-ups, with headroom.
**Mitigations:** tools return compact aggregates only, full time series go to the UI as
structured evidence and never into the prompt; evidence is summarized to one line per card for
model context; `max_tokens` is set explicitly on every call.

---

## 5. Definition of done for this plan

P0 ships when all twenty-one PRD §24 boxes are checked, all five milestones in
`docs/BUILD_STATUS.md` read `complete`, and the PRD §20.5 manual acceptance test passes
against the **deployed** URL.
