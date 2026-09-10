PROMT1 -> Claude
Read docs/PRD.md completely.

Do not implement anything yet.

Create docs/BUILD_PLAN.md that reduces the PRD to the smallest credible P0 build.

Requirements:
1. Use only the golden account abc123 and the invoice_variance case.
2. Divide implementation into five independently verifiable milestones.
3. For each milestone, list:
   - files/components to create
   - acceptance criteria covered
   - tests that must pass
   - manual verification step
4. Identify current Cloudflare SDK/API uncertainties that need a technical spike.
5. Explicitly exclude P1 and P2 functionality.
6. Do not use Workflows, R2, Vectorize, AI Gateway, authentication, or additional accounts in P0.
7. Create a concise CLAUDE.md/AGENTS.md containing permanent project rules, commands, architecture boundaries, and definition of done. Keep it under 150 lines.
8. Create docs/BUILD_STATUS.md with the milestones initially marked pending.

Stop after creating and presenting the plan. Do not scaffold the application.

PROMT2 -> Claude

Implement Milestone 1 from docs/BUILD_PLAN.md: the platform smoke test only.

Objectives:
1. Scaffold the current Cloudflare Agents starter.
2. Configure:
   - Workers AI binding
   - @cf/meta/llama-3.3-70b-instruct-fp8-fast
   - Agents SDK/Durable Object session
   - D1 binding
3. Add one D1 migration containing only an accounts table.
4. Seed synthetic account abc123 / Acme Corp.
5. Add one read-only tool, get_account_context.
6. Build a minimal chat page that can answer:
   “What account am I investigating?”
7. Persist the conversation across a browser refresh.
8. Add one tool contract test.
9. Run typecheck, lint, tests, and local build.

Do not implement invoice calculations, the full agent playbook, or the final UI.

Update docs/BUILD_STATUS.md and PROMPT_HISTORY.md.
Stop when the smoke test works or report the exact blocker.

---

## Outcomes

### PROMPT 1 — 2026-09-09 · Claude Code (Opus 5)

Read the PRD in full. Created three documents, no code.

- `docs/BUILD_PLAN.md` — P0 reduced using one test: does cutting this break a §24
  DoD checkbox or a §20.4 golden assertion? Cut `get_evidence_details` (evidence
  already lives in durable state), token-level streaming, multi-tier rating, and
  the sub-daily change timestamp. Five milestones, six timeboxed spikes.
- `CLAUDE.md` — 124 lines: permanent rules, commands, layer boundaries, DoD.
- `docs/BUILD_STATUS.md` — all milestones/spikes `pending`.

Grounded the spike list against live Cloudflare docs first. Two findings shaped
the plan: Llama 3.3 fp8-fast has a **24,000-token** context window and a
`max_tokens` default of **256**; `response_format` exists but is undocumented for
that model.

Committed as `efd5b58`, pushed to github.com/ombhatt/billing-investigator.

### PROMPT 2 — 2026-09-09 · Claude Code (Opus 5)

Implemented Milestone 1. Resolved spikes S3, S4, S5 against the real SDK rather
than docs, since several documented APIs had moved.

Spike outcomes:

- **S3** — `agents@0.22.0`. `AIChatAgent` now ships from `@cloudflare/ai-chat`,
  not `agents`; `useAgentChat` from `@cloudflare/ai-chat/react`. Model calls go
  through `workers-ai-provider` + `ai` v6 `streamText`. Chose `AIChatAgent` for
  free DO-backed message persistence.
- **S4** — `new_sqlite_classes` confirmed as the migration syntax. Verified at
  runtime: the DO namespace reports `use_sqlite: true`.
- **S5** — `@cloudflare/vitest-pool-workers` API changed. `defineWorkersConfig`
  and the `/config` subpath are gone; the current API is a `cloudflareTest()`
  Vite plugin from the package root, requiring vitest `^4.1.0`. Its
  `remoteBindings: false` option is what keeps tests off the network.

Files created: `wrangler.jsonc`, `package.json`, `tsconfig.json`,
`vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`,
`migrations/0001_accounts.sql`, `seed/0001_accounts.sql`,
`src/server.ts`, `src/agent/systemPrompt.ts`, `src/tools/{definitions,
getAccountContext,envelope}.ts`, `src/repositories/accountRepository.ts`,
`src/types/tools.ts`, `src/{app.tsx,client.tsx,styles.css}`,
`test/setup.ts`, `test/integration/getAccountContext.spec.ts`.

Gates: typecheck, lint, 10/10 tests, and build all pass. Migrations applied and
`abc123` seeded and verified in local D1.

**Blocker at first report — live chat smoke test not run.** Workers AI has no
local emulation, so `vite dev` proxies AI calls to Cloudflare and needs a login.
`wrangler whoami` reported not authenticated and the dev server failed to start
at all.

### PROMPT 2 continued — after `wrangler login`

Two further blockers surfaced and were cleared:

1. **Error 10063 on `/workers/subdomain/edge-preview`.** The remote proxy session
   needs a `workers.dev` subdomain on the account. Resolved once
   `om-bhatt.workers.dev` existed. Fails identically with and without
   `remote: true`, so it is a hard prerequisite, not a config choice.

2. **`workers-ai-provider` streaming defect (spike S1).** The first live run
   produced five `get_account_context` calls and no answer. A temporary
   diagnostic route showed why: under `workers-ai-provider@3.3.1` with
   `ai@6.0.280`, streamed tool-call argument deltas are appended rather than
   replaced, yielding `{"accountId": "{"accountId": "abcabc123"}123"}` — invalid
   JSON, so the tool never ran, no result was fed back, and the model retried to
   the step limit. The identical request through `generateText` returned clean
   arguments and a correct answer in two steps.

   Fixed by switching `onChatMessage` to `generateText` plus a
   `createUIMessageStream` response. This matches the existing P0 decision to cut
   token-level streaming, so it costs nothing. Upgrading is not an option yet:
   provider v4 needs `ai@^7`, while `@cloudflare/ai-chat` pins `ai@6`.

**Smoke test passes.** One tool call; the answer correctly identifies Acme Corp. /
`abc123` / Synthetic Enterprise / USD / `api.acme.example`, and reports no
available invoices rather than inventing any. The conversation survives a full
page reload, and Reset clears state. All four gates green.

**Milestone 1 complete.** Created D1 `billing-investigator`
(`01b1a493-7a9e-4787-ae40-daf3be4668b1`), migrated and seeded it remotely, and
deployed to https://billing-investigator.om-bhatt.workers.dev with all four
bindings attached. Smoke test re-verified against the deployed URL, including
state restored after reload.

Open for later milestones: the model infers the account id from the tool schema's
`.describe()` example (M4 must inject it explicitly), and `SESSION_NAME` is a
fixed constant so all visitors share one investigation (M4 replaces it with a
real investigation id).

PROMT3 -> Claude

Implement Milestone 2: deterministic billing domain and synthetic data.

Read the relevant computation, synthetic-data, data-model, and testing sections of docs/PRD.md.

Implement:
1. Complete P0 D1 schema and migrations.
2. Reproducible synthetic seed generator for abc123.
3. June, July, and August 2026 data.
4. Exact July invoice total of $16,900.
5. Exact August invoice total of $21,720.
6. Deterministic domain modules for:
   - rating
   - invoice generation
   - invoice comparison
   - price/volume variance decomposition
   - duplicate detection
   - change-point detection
   - reconciliation
   - confidence calculation
7. Integer-cent currency calculations.
8. Unit tests for every golden value in the PRD.

Do not connect these calculations to the LLM yet.
Do not build additional UI.
Do not hardcode the final narrative answer.

Add a development-only command that runs the golden calculations and prints structured JSON.

Run all tests, lint, typecheck, and build.
Update BUILD_STATUS and PROMPT_HISTORY.
Stop and report results.

### PROMPT 3 — 2026-09-09 · Claude Code (Opus 5)

Milestone 2 complete. 109 tests across 9 files; typecheck, lint and build green.

Added `migrations/0002_billing_schema.sql` (nine tables, FKs, indexes),
`seed/` (seeded PRNG, constants, generator, SQL emitter, runner), eight domain
modules under `src/domain/`, and `scripts/goldenFacts.ts` behind `npm run golden`.

`npm run golden` prints exactly the PRD §20.4 block: 2172000 / 1690000 /
482000 cents, 28.5%, Workers 464000, Workers AI 18000, price_changed false,
change_date 2026-08-14, dep-1842, 0/0 duplicates, reconciliation passed,
100% explained, confidence high.

Three decisions worth recording:

1. **Change-point detection needed a refinement.** PRD §12.7's median-window
   scan does not uniquely select August 14 — a five-day post-window reads as
   shifted when only three of its days are, so medians tie across August 12-16
   and jitter picks the winner. Added an onset rule: the candidate day must be
   in the new regime and the day before it must not. Documented in
   `BUILD_STATUS.md` and asserted by a test that the neighbours are not chosen.

2. **Exact monthly totals without hardcoding.** Each month's target is
   distributed across weighted hourly slots with the remainder going to the last
   slot, so July lands on 1,000,000,000 requests and August on 1,580,000,000
   regardless of the daily shape.

3. **Retired the hand-written `seed/0001_accounts.sql`.** The generator now
   emits the account row too, so the golden figures live only in
   `seed/constants.ts`. Generated SQL goes to `.seed/golden.sql`, which is
   gitignored.

Verified against D1, not only in memory: migration applied and generated SQL
loaded locally, with `invoices` returning 1690000 and 2172000 cents.

Nothing is wired to the LLM; `src/domain/` imports no Cloudflare binding and its
tests run in plain Node.

PROMT4 -> Claude

Implement Milestone 3: typed investigation tools.

Implement the P0 tools from docs/PRD.md:
- get_account_context
- compare_invoices
- decompose_variance
- get_usage_timeseries
- get_price_versions
- detect_usage_change_point
- get_account_events
- check_duplicate_usage
- reconcile_invoice

Requirements:
1. Tools must call tested domain/repository functions.
2. Tools may not accept arbitrary SQL.
3. All D1 access must use prepared statements.
4. Every result must include sourceRecordIds, evidence, executedAt, and dataLimitations.
5. Enforce account scoping to abc123.
6. Add input validation.
7. Add tool contract and authorization tests.
8. Add a deterministic investigation runner that executes the complete golden investigation without using an LLM.

Do not implement agent planning yet.
Do not substantially change the UI.

Run all verification commands and update project documentation.

### PROMPT 4 — 2026-09-09 · Claude Code (Opus 5)

Milestone 3 complete. 195 tests across 11 files; typecheck, lint and build green.

Added five repositories, all nine tools, a `createTool` wrapper carrying
validation / account scoping / safe errors, the allowlist and caching
`ToolRunner`, and `investigationRunner.ts` behind `npm run investigate`.

**The exit criterion held:** the golden fact block produced by running the nine
tools against D1 is asserted equal to the pure-domain block. That is the check
the M2 tests could not make — a repository that mis-mapped a column would pass
every domain test and fail this one.

Three decisions worth recording:

1. **The model's tool surface is unchanged at one tool.** All nine exist and are
   allowlisted, but `buildTools()` still exposes only `get_account_context`.
   Handing this model nine tools without M4's bounded loop invites the retry
   loop already seen in M1, and it would regress the deployed demo. The registry
   is the seam M4 opens.

2. **`createTool` wrapper rather than nine hand-rolled tools.** Validation,
   scope enforcement and error mapping happen once. Nine near-identical
   implementations would eventually differ in exactly the security-relevant
   step.

3. **A static SQL-safety test, not only behavioural ones.** A behavioural test
   proves only the inputs it tries. `test/unit/sqlSafety.spec.ts` asserts that
   only ALL-CAPS column constants are interpolated into a `prepare()` template,
   that the tool layer contains no SQL, and that the read path contains no write
   statement.

   Its first version was too blunt and flagged `` `${period}-%` `` — a *bind
   value*, not SQL text. Scoped it to the `prepare()` argument and verified it
   still fails on an injected `${accountId}` in SQL text.

No agent planning, no UI change.

PROMT5 -> Claude

Implement Milestone 4: bounded invoice-variance agent.

Use the existing tested tools. Do not change their financial calculations unless a failing test proves a defect.

Implement:
1. invoice_variance case classification.
2. The fixed investigation playbook from docs/PRD.md.
3. Required first steps: compare invoices, decompose variance.
4. Conditional usage investigation: usage time series, price versions, change point, account events, duplicate check.
5. Mandatory reconciliation before declaring the invoice correct.
6. A maximum of 12 tool calls and 4 planning cycles.
7. Persistent plan, step status, tool results, evidence, and final summary.
8. Server-side completion criteria.
9. Deterministic confidence.
10. Follow-up questions using existing evidence.
11. Mocked-model integration tests.

The LLM may: classify the question, select conditional tools, update hypotheses, explain evidence.
The LLM may not: calculate financial totals, execute arbitrary SQL, skip reconciliation,
change confidence, invent records, claim deployment causation.

Do not expose chain-of-thought.
Run all tests and update documentation.

### PROMPT 5 — 2026-09-09 · Claude Code (Opus 5)

Milestone 4 complete. 231 tests across 13 files; typecheck, lint and build green.
Verified live against Workers AI as well as under mocks.

Added `src/agent/`: types, state machine, the fixed playbook, a three-method
`ModelClient` seam, server-side completion criteria, deterministic summary,
follow-up handling, the bounded loop, and the Workers AI implementation. Wired
into the Durable Object with `setState` for the record and `this.sql` for the
tool-execution audit trail.

**The central design choice: the model never touches a tool.** It is reached only
through `ModelClient` (classify / plan / explain); the server builds every tool
input from the investigation record. That turns the "may not" list into
structure rather than prompt compliance — reconciliation runs outside the
planning loop, the state machine has no `investigating -> completed` edge,
confidence is computed after the loop, and a model-supplied account id is
discarded. It also makes the whole loop testable with a scripted client.

**Two defects only the live run could find.** Both passed every mocked test:

1. The model wrote its own Assessment and Recommended next step, and its
   version ("no further investigation is required") *contradicted* the computed
   recommendation directly beneath it. Fixed by asking for the finding sentence
   only, plus a `usableFinding()` guard that discards prose writing those
   sections. Two regression tests added.

2. Follow-ups reused the summary prompt, so "could the usage have been
   duplicated?" returned a restatement of the variance. Added
   `ExplainInput.mode`, and follow-ups now get the evidence cards rather than
   only the fact block. After the fix: "No... 0 exact and 0 probable duplicates
   across 1,488 events", with no new tool calls.

A third defect in the UI: `sendMessage` silently drops a message when the socket
is not yet open while the composer stayed enabled — the cause of repeated lost
first clicks. Controls are now gated on `connected`.

One test of mine was wrong and worth recording: I asserted the zone evidence
showed ~97% on the primary zone. It shows 83%. 97% is the primary zone's share
of the *increase*; 83% is its share of August's total, and a single-period series
cannot yield the former. Corrected the assertion rather than the code, and logged
the limitation instead of overclaiming.

### PROMPT 5 follow-up — deployed-build defect found by the user

Deployed M4 to production (migration 0002 applied remotely, 4,819 rows seeded,
worker deployed). The user then reported that questions returned a short answer
with no plan steps and no structured summary, and that Reset did not help.

Correct report, and a real bug of mine. `clearHistory()` deletes the chat
messages but not this agent's `setState` record, so the investigation stayed
`completed` and every subsequent question was routed to the follow-up path —
which by design runs no tools and returns no summary. My earlier explanation
("hit Reset") was wrong because Reset could not clear it.

Behind it was a latent crash: passing a terminal record back into
`runInvestigationTurn` would have thrown an opaque state-machine transition
error, masked until now by the follow-up branch.

Fixed both: the first user message of a conversation always starts a new
investigation, and the loop rejects a terminal record with a message saying what
to do instead. Two regression tests. Redeployed and verified the exact reported
flow — Reset, then ask — now produces nine tool steps and the full summary.

