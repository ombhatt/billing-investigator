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


PROMT6 -> Claude

Implement Milestone 5: production-quality demo interface and deployment readiness.

Build the P0 user experience from docs/PRD.md:
1. Synthetic-data disclosure.
2. abc123 account header.
3. Suggested golden prompt.
4. Two-column desktop layout.
5. Conversation panel.
6. Plan, Evidence, and Summary tabs.
7. Visible step status without chain-of-thought.
8. Evidence cards with source IDs and confirmed/correlated status.
9. Loading, retry, unresolved, and failure states.
10. Persistent refresh behavior.
11. Reset Demo action that does not mutate seed data.
12. Responsive and keyboard-accessible behavior.

Do not add P1 accounts or new functionality.

After implementation:
- run tests, lint, typecheck, and production build
- inspect for secrets
- complete README.md
- complete ARCHITECTURE.md
- update PROMPT_HISTORY.md
- provide exact local and Cloudflare deployment commands

### PROMPT 6 — 2026-09-09 · Claude Code (Opus 5)

Milestone 5 complete; P0 done. 233 tests, typecheck, lint and production build
all green. Secret scan clean across source, tests, config and the built bundle.

Replaced the single-column placeholder with composed components under `src/ui/`:
masthead, account header, conversation, and an `InvestigationPanel` holding the
Plan / Evidence / Summary tabs. Added `GET /api/accounts/:id` so the account
header can render before any investigation runs.

The panel reads the investigation record straight off the Durable Object's
synced state, so plan steps, evidence cards and the summary all restore on
refresh with no extra plumbing. The tab follows the investigation automatically
but stops doing so the moment the reader picks a tab themselves.

Verified in a browser rather than reasoned about:

- two-column ratio measured at `745.797px / 610.203px` (≈55/45), no horizontal
  overflow; `@media (max-width: 940px)` stacks to one column; dark-mode and
  reduced-motion rules both present
- tablist has a label, roving tabindex, `aria-selected` and `aria-controls`, and
  a labelled panel; ArrowRight moved Plan→Evidence and End→Summary with focus
  and selection staying in sync
- refresh restored the conversation, both tab counts and the full summary
- **Reset demo vs seed data**: captured row counts, invoice totals and total
  usage quantity from D1 before and after. Identical — 4,508 events, 276 daily
  rows, 15 lines, 5,535,500 cents, 3,572,500,000 units. This is PRD §20.5 step 9
  and it now has evidence rather than an assertion.

Status is never carried by colour alone: every badge pairs a distinct glyph with
its label, which covers both PRD §8.4 and §21.

Wrote `README.md` (purpose, the LLM-plans/code-calculates decision as a table of
enforced guarantees, prerequisites including the Workers AI remote-only caveat,
exact local and deploy commands, the demo and its expected figures, scope and
known limitations) and `ARCHITECTURE.md` (component diagram, agent loop, the
model seam and why it exists, state machine, data lineage, tool-security
boundary, state ownership, failure-mode table, tradeoffs, production evolution).

### Review finding 1 — 2026-09-09 · Claude Code (Opus 5)

**P0: browser clients could replace authoritative investigation state.** Verified
against the installed SDK before acting, and the finding was correct.

Three facts line up in `node_modules/agents/dist/src-5W6JNKVb.js`:
`isStateUpdateMessage` accepts `cf_agent_state` from a connection;
`_setStateInternal` persists to `cf_agents_state` and broadcasts to every other
connection; and `validateStateChange(_nextState, _source) {}` is a no-op default
I never overrode. `isConnectionReadonly` is likewise false unless an internal
flag is set. So a browser could publish a fabricated `completed` investigation
with invented totals and `invoiceAppearsCorrect: true`, and follow-ups would
answer from it. That breaks CLAUDE.md rules 1, 6, 9 and 12 at once.

Root cause was mine: Reset called `agent.setState()` from the client, which
required that write channel.

Fixed by making state server-owned: `validateStateChange` throws for any source
other than `"server"`, and Reset became a server-owned `POST
…/reset-investigation` handled by the agent's `onRequest`.

Two things worth recording:

1. **My first fix had a bug of its own.** `agent.getHttpUrl()` carries a query
   string, so string concatenation produced
   `…/demo-abc123?_pk=…/reset-investigation` — the segment landed inside the
   query, the server saw a pathname ending in `demo-abc123`, and the request
   fell through silently. Caught by checking the actual request URL in the
   browser rather than assuming the fix worked. Now built with the URL API.

2. **The regression test is the one the reviewer asked for, not a proxy for it.**
   Enabling `main` in the integration project let a test open two real agent
   WebSockets, send a forged record from one, and assert the attacker gets
   `cf_agent_state_error`, the other client receives nothing carrying it, and a
   fresh connection still syncs untouched state. Removing the guard fails it.

Also verified manually in the browser: the forged frame is rejected, `FORGED`
appears nowhere in another client's DOM, and Reset still clears both the
conversation and the record. 240 tests; typecheck, lint and build green.

### Review finding 2 — 2026-09-09 · Claude Code (Opus 5)

**P0: reconciliation could pass without verifying the billing pipeline.**
Reproduced every claim before fixing, and found four more.

A probe against the seeded dataset returned `passed` for all of these:

| Case | Old result |
|---|---|
| rated-charge `amountCents` set to 1 | passed |
| **all usage, daily usage and rated charges removed** | **passed, 1 checkpoint** |
| `subtotalCents` set to 1 | passed |
| `priceVersionId` corrupted | passed |
| `billableQuantity`/`includedQuantity` corrupted | passed |
| usage line unlinked from its rated charge | passed |
| orphan rated charge for a service with no usage | passed |

The second is the serious one: an invoice certified correct with nothing behind
it. The per-service loop was enumerated from raw and daily usage, so with those
gone it ran zero times and only the invoice-total check remained — which tied
out, because the invoice was intact. That made "never claim correctness without
reconciliation" hollow in precisely the case it exists for.

The other cause: the boundary named `rated_charge_vs_invoice_line` actually
compared *recomputed* cost to the invoice line, so the stored rated charge was
never examined at all, and `subtotalCents` was never read.

Rewrote it around one rule: **reconciliation must fail when a stage is absent,
not only when two present stages disagree.** Services are now enumerated across
all four stages, and each stage is verified independently — raw → daily, daily →
rated quantity, the charge's own billable arithmetic, the price version it
cites, recomputation → stored charge, stored charge → line, line linkage, lines
→ subtotal, subtotal → total. Ten boundary types, eighteen checkpoints on the
golden scenario, all at zero.

Fixed-fee lines (Platform fee, R2, D1) are exempt from stage coverage — they
legitimately have a line and no usage pipeline — but their amounts still have to
tie into the subtotal. A test covers both halves, because getting that wrong
would either fail the golden path or leave a hole.

PRD §12.9's four required boundaries all remain; the six additions are strictly
stronger. 22 new tests in `test/unit/reconciliationDefects.spec.ts`, each
corrupting or removing exactly one thing and asserting the specific boundary
that should notice. Golden facts unchanged across all three paths.

263 tests, up from 240. Only one existing test needed changing: it asserted the
boundary set was *exactly* the four required ones.

### Review finding 3 — 2026-09-10 · Claude Code (Opus 5)

**P0: generated prose could invent amounts, records, causation and
correctness.** Reproduced first: a mocked model returning

> "The invoice rose by $99,999 because dep-FAKE caused duplicate charges.
> The invoice is correct."

reached the user verbatim in both the summary finding and the follow-up, while
`facts.variance_cents` stayed correctly at 482000. Four fabrications in one
sentence, none caught.

My `usableFinding` was built for the duplication problem I hit live in M4 —
prose writing its own Assessment section — and only ever checked for empty text
and section labels. It was never a fabrication guard, and I had wrongly treated
"structured facts are correct" as sufficient. It is the sentence, not the fact
table, that gets pasted into a customer email.

Added `src/agent/narrativeGuard.ts`, enforcing: **the model may only restate
figures and identifiers that already appear in verified evidence.** It builds an
allowed vocabulary from the fact block plus the evidence cards, then rejects
unknown amounts, identifiers, percentages and dates; causal verbs sharing a
sentence with an event id; correctness claims when the invoice is not
established correct; and confidence levels contradicting the computed one.
Rejection is all-or-nothing — one fabricated figure discredits its sentence — and
summary and follow-up now go through the same function.

The risk in a guard like this is the opposite failure: rejecting genuine output
and silently degrading every answer to boilerplate. So a test pins wording
captured verbatim from a real Workers AI run, and I re-ran the live demo after
wiring it — the Summary tab still reports "Wording generated by the model from
verified figures", not the fallback.

Causation is judged per sentence, so "the rise was caused by higher request
volume" passes while "dep-1842 caused the increase" does not.

287 tests, up from 263. Mutation-checked: neutering the guard fails six tests
across unit and integration. Documented limit — bare quantities such as
"1,488 events" are not yet validated, only currency, percentages, dates and ids.

### Review finding 4 — 2026-09-10 · Claude Code (Opus 5)

**P1: completion treated unperformed diagnostics as sufficiently checked.**
Reproduced with a model that ends planning on the first cycle:

```
STATE      >>> completed
CORRECT?   >>> true
CONFIDENCE >>> high
BLOCKERS   >>> []
DUPS       >>> exact= null  probable= null
PRICE      >>> null  CHANGEDATE: null
RAN        >>> get_account_context, compare_invoices, decompose_variance, reconcile_invoice
SKIPPED    >>> usage timeseries, price versions, change point, account events, duplicates
```

The agent told the user the invoice appears correct, with high confidence and no
caveats, having never looked at duplication, pricing, usage shape or operational
correlation. `(facts.exact_duplicate_count ?? 0)` is what hid it: `null` meaning
"never checked" became `0` meaning "checked, none found".

Only the prelude and reconciliation were required; everything else was the
model's choice. That contradicts PRD §10.5 rule 5.

Fixed by deriving the required set from the deterministic variance rather than
leaving it to the model: variance ≠ 0 requires the price check; a non-zero
volume effect requires usage series, change point and duplicate checks; a found
change point requires the events check. Missing any is a blocker, which blocks
both "appears correct" and high confidence. Duplicates can only be cleared by a
check that ran.

This needed `volume_effect_cents` and `price_effect_cents` in the fact block, and
adding them broke the golden assertions in all three paths — which is the design
working: domain, tools and agent blocks are compared for exact equality, so a
fact cannot be added to one without the others noticing. Updated all three; the
§20.4 values are unchanged.

291 tests, up from 287. Mutation-checked: removing the derivation fails three.

Note on severity — reported as P1, but an agent claiming an invoice is correct
without checking duplication is closer in kind to findings 2 and 3 than the label
suggests. Fixed at the same priority.

### Review finding 5 — 2026-09-10 · Claude Code (Opus 5)

**P1: Workers-only diagnostics became invoice-wide claims.** Both probes
reproduced exactly.

| Reality | Agent said |
|---|---|
| Workers AI duplicate worth $4.13, propagated through every stage | "No exact or probable duplicate usage was found", confidence high |
| Workers AI rate tripled, invoice $22,380 | "Contract pricing did not change", confidence high |

`FOCUS_SERVICE` was a compile-time constant. Every diagnostic ran against
Workers while the summary spoke for the whole invoice, so a fault in any other
service was invisible and the answer was confidently wrong about it.

Fixed so the scope of the check matches the scope of the claim. Metered services
are taken from the decomposition — the only stage that sees them all — and the
price and duplicate checks run once per service as `tool:service` plan steps.
Facts now accumulate instead of overwriting: `price_changed` is an OR, duplicate
counts a SUM. Previously whichever service was checked last decided the
invoice-wide answer. Completion requires the per-service ids.

The investigative focus is now the largest absolute mover rather than a
constant. A test seeds it to `"R2"` — a fixed-fee line with no usage at all —
and asserts it is corrected to `"Workers"`, so the derivation is proven rather
than coincidentally right.

Worth flagging: **the golden path now uses 11 of the 12 permitted tool calls.**
A third metered service would exceed PRD §10.6's limit; the loop would skip the
remainder and finish `unresolved` rather than assert something unchecked, which
is the right failure direction, but the headroom is thin and the limit would
need revisiting before seeding more services. Documented in ARCHITECTURE §13.

302 tests, up from 291. Mutation-checked: reverting to a single scope fails
twelve, including the golden fact block — the per-service checks are now load
bearing for the primary result, not an optional extra.

### Review finding 6 — 2026-09-10 · Claude Code (Opus 5)

**P1: fixed-fee movement was treated as proof the fee was valid.** Reproduced:
raising August's platform fee by $100 with the subscription untouched gave

```
STATE       completed | conf: high
EXPLAINED   100%
RECON       passed
BLOCKERS    []
INVOICE FEE 610000 vs SUBSCRIPTION: 600000
VERDICT     true
```

The subtle part, and the thing I had wrong: the decomposition *correctly*
labelled the movement a fixed-fee effect, which made it **explained** — and I was
letting "explained" stand in for "valid". Attribution is not authorisation.
`grep` confirmed nothing read the `subscriptions` table anywhere in the read
path.

Added a subscription repository and two boundaries:
`fixed_fee_vs_subscription` compares each fixed line to the fee its subscription
authorises, and `subscription_active_for_period` requires that subscription to be
in force — so an ended subscription still billing fails, as does one that has not
started. A subscription ending *inside* the period still passes, since it was
legitimately billable for part of it.

For R2 and D1, which PRD §13.5 makes illustrative flat charges with no
authorising record, the honest answer was to name the limit rather than paper
over it: reconciliation reports them in `unverifiedFixedCharges`, and completion
blocks "appears correct" if such a charge *moved*. They do not fail the golden
invoice merely for existing, because they are static there.

315 tests, up from 302. Mutation-checked: removing the subscription comparison
fails six, including the end-to-end unauthorised-fee case.

### Review finding 7 — 2026-09-10 · Claude Code (Opus 5)

**P1: a partially effective price was applied to a whole month.** Probe:

```
ACCEPTED  covers whole month (control)  -> 2026-01-01..open
ACCEPTED  STARTS LATE  (Aug 14 onward)  -> rated Aug 1-31
ACCEPTED  ENDS EARLY   (until Aug 10)   -> rated Aug 1-31
ACCEPTED  WINDOW ONLY  (Aug 10-20)      -> rated Aug 1-31
```

A contract effective for eleven days priced all thirty-one. `effectivePrice`
required exactly one *overlapping* version and I had read overlap as coverage.

Added `covers()` — starts on or before the window opens, still in force when it
closes — and `effectivePrice` now throws when the sole candidate fails it,
naming the version and its dates so the gap is diagnosable rather than silent.
`coverageGap()` reports the same without throwing, and `get_price_versions`
surfaces it as a data limitation.

Worth noting the second half: **invoice generation had its own copy of the
overlap filter**, so the same defect existed in two places independently and
fixing one would have left the other. `generateRatedCharges` now calls
`effectivePrice` rather than repeating the logic — the duplication was the
reason the bug could hide twice.

The taxonomy is now explicit: one spanning version rates; two versions are a
price change; one non-spanning version is a coverage gap; none is no price. The
middle case is the one that had been collapsing into the first.

333 tests, up from 315. Mutation-checked: accepting overlap as coverage again
fails six, including invoice generation and reconciliation. Golden facts
unchanged — the seeded Workers and Workers AI versions both run from
2026-01-01 with no end, so they cover every period.

---

### Review finding 8 (P1) — all visitors share one investigation; Reset does not isolate in-flight work

> One visitor sees or clears another visitor's conversation. Reset during
> inference can be followed by the old investigation writing its result back
> into the cleared state.

Two defects with one shape, both confirmed.

**Shared identity.** The name given to `useAgent` is the Durable Object instance
id, and it was a module constant, `demo-abc123`. Every browser on the deployed
demo joined the same conversation. Each browser now resolves its own id from
`localStorage` (`src/ui/session.ts`), and only a value the app issued itself is
accepted back out — the id lands in the agent's routing path, so a tampered
`../something` would address a different instance. Conversations are separated;
tenancy is not, since every visitor still investigates the single seeded
`abc123`.

**Stale turns could commit.** The reviewer was right that `_options.abortSignal`
was ignored. The SDK does abort the active turn on clear, but abort only stops
the transport: the server-side turn was an awaited promise chain that resumed
when its model call resolved and persisted the record into the conversation the
reader had just cleared. The conversation now carries a server-owned
`generation` (`src/agent/generation.ts`); Reset advances it, and a turn commits
only into the generation it opened in. The abort signal is honoured too. The
check sits immediately before `setState` with no `await` between them.

Tool executions still reach the audit trail — they genuinely ran. It is the
investigation record that must not come back from the dead.

353 tests, up from 333. Mutation-checked twice: making the commit guard always
return true fails six (three of them through the real `onChatMessage`, which is
what proves the stale turn really did write back), and restoring the shared
constant name fails nine.

The integration test builds a stand-in for the DO's persistence and runs the
real `onChatMessage` and `onRequest` against it, with a model gated inside
`classify` so the reset lands while the turn is genuinely parked. A control case
asserts an uninterrupted turn still commits, so the guard tests cannot pass
vacuously on a turn that never finished.

---

### Review finding 9 (P1) — clarification replies cannot complete classification

> After asking which months to compare, the agent cannot use a valid answer. It
> proceeds with null periods and returns unresolved.

Both halves confirmed. The clarification branch was three lines that moved the
state to `planning` and did nothing else — classification lived only in the
`created` branch, so the one path that could set the periods was the one path a
clarification reply never took. Null periods make `inputFor()` return null, so
every tool was skipped and the turn ended `unresolved`, the reader having
answered correctly.

Both branches now share `classifyPeriods`. A reply is classified against the
request it answers: "August versus July 2026" names no account and asks nothing,
so the model gets the original question, the question put to the reader, and the
reply. `originalQuestion` is persisted for this and survives the round trip.

Re-asking also had to become a legal transition. `clarification_required` listed
only `planning` and `failed`, so a second unclear reply would have thrown
`InvalidTransition` — fixing the first defect alone would have turned a vague
answer into a crash.

The second half — silently swapping an unavailable period for the newest
invoice — was the more dangerous one, since "why did May jump?" became a
confident, reconciled answer about August with nothing marking it as the wrong
question. Requested periods the account lacks are now named alongside the ones it
has, and the investigation waits. The fallback survives only where the model
could not be reached at all: nothing was requested, so nothing is overridden.

**An existing test asserted the substitution as the requirement** — "falls back
to the two most recent periods when the model offers unknown ones". Review was
right and the test was wrong. It was rewritten rather than deleted, with a
comment recording what it used to claim.

361 tests, up from 353. Mutation-checked twice: restoring the no-op clarification
branch fails three, restoring the silent substitution fails three more. Golden
facts unchanged.

Also corrected two stale claims in `ARCHITECTURE.md` found while writing this up:
the state diagram had no self-loop on `clarification_required`, and the loop
section still said the golden path uses nine tool calls rather than eleven.

**Post-deploy: the same defect one layer lower.** Verifying finding 9 in
production, "why did my May 2026 invoice jump compared to April 2026?" still
returned a reconciled, high-confidence answer, the prose reading *"The May 2026
invoice jumped by $4,820.00 compared to April 2026"* over August and July's
data.

My fix validated the model's *answer*. But shown the available periods, the live
model does not report the months it was asked about — it quietly answers with
the available ones, so the substitution happens inside the model where no check
of its output can see it. The reader's own words are now checked first, against
the invoices the account has, before the model is consulted at all.

The prose was the second half, and the more interesting one: **every amount and
identifier in that sentence was real**, so the narrative guard had nothing to
object to. It checked the figures and never checked what the answer was *about*.
`periodsMentioned()` now reads months in either spelling and prose naming a
period that was not investigated is rejected like any other fabrication.

378 tests, up from 361. Mutation-checked: removing either guard fails four.

---

### Follow-up — raw tool names in the plan panel

Spotted while verifying finding 9 in production: the Plan tab rendered the
friendly label and then the raw identifier beside it — `Confirming the account`
followed by `get_account_context`.

PRD §7.2 asks for "tool names **translated into** user-friendly actions". The
label was doing the translating and the `<code>` element was undoing it. Removed,
along with its now-unused style rule.

The complement matters and is now asserted too: PRD §8.3 lists "Source/tool
name" among the six fields every evidence card must carry, so evidence still
names its source. The rule is about how a *plan step* is named, not a blanket
ban on tool names in the UI — a test that simply forbade them everywhere would
have been wrong.

383 tests, up from 378. Static check in the style of `sqlSafety.spec.ts`, since
there is no DOM test setup; comments are stripped before scanning, because the
comment explaining the rule has to name the identifier the rule is about.
Mutation-checked: putting the element back fails it.

---

### Review finding 10 (P1) — flat usage produces a confirmed change date

> A constant 31-day series returns detected: true and 2026-08-08, despite ratio
> 1 and material: false.

Reproduced exactly, including the date. The scan always yields a best row, and
that was returned as `detected: true` unconditionally; on flat data every
candidate ties at ratio 1.00 and the earliest tie won.

The damage was done one layer up. `applyToolFacts` kept only `changeDate` and
dropped `ratio`, `material` and `confidence` — the very qualifiers that said not
to believe it — so a rejected candidate reached the summary indistinguishable
from a real shift, and `get_account_events`, anchored on `facts.change_date`,
manufactured an event correlation for a change that never happened.

Detection is now an acceptance rather than a ranking: the ratio must depart from
the baseline materially, in either direction, since a sustained fall is as real
a change point as a rise. A rejection still reports its candidate, ratio and
reason, so "no change point" is an answer rather than a silence. The qualifiers
travel with the date on all three paths.

Adding two fields to the fact block broke all three golden assertions at once —
the cross-path equality check doing its job.

394 tests, up from 383. Mutation-checked twice: accepting every candidate again
fails seven, and letting facts keep the date regardless of acceptance fails one.
Golden facts unchanged apart from the two new qualifiers, both of which the
August 14 change point satisfies.

Also rewrote CLAUDE.md rules 21, 23, 25 and 26 to carry findings 9 and 10 while
staying inside the 150-line limit from PROMPT 1 — now 149.

---

### Review finding 11 (P1) — the zone-growth follow-up lacked comparative evidence

> "Which zone generated the increase?" can only be answered by guessing from
> August's distribution or admitting insufficient evidence.

Correct, and this one I had already half-seen: `README.md` carried it as a known
limitation ("answered approximately") rather than a defect. Review was right
that a required PRD §7.4 follow-up answered with the wrong quantity is a defect,
not a caveat. Approximately-right was doing a lot of work in that sentence: 83%
of the period and 96% of the growth are answers to different questions that
happen to sit near each other in this dataset.

Of the two routes offered I took the first, persisting the comparison, because
it keeps the arithmetic in `src/domain/` where it is provable in plain Node, puts
the figure on the record before any follow-up is asked, and lets follow-ups keep
their guarantee of running no tools. `get_usage_timeseries` takes an optional
comparison window from the server — never from the model — and does a second
read inside the same call: one extra query, not one extra tool call, so the
budget is untouched and the golden path still runs eleven.

The exact figures from review reproduce: +556,595,994 of 580,000,000, or 95.96%,
against an 82.70% share of August. Both are asserted, plus the case that proves
they are different questions — the largest zone by volume contributing zero
growth.

410 tests, up from 394. Mutation-checked twice: dropping the comparison window
fails three, and collapsing growth share into period share — the exact confusion
— fails seven. Golden facts unchanged.

The README limitation is retired and replaced with the one that is actually
true: follow-ups run no new tools, so a question needing genuinely new data is
declined rather than answered.

---

### Found in manual testing — a follow-up about an uninvestigated month

The user asked, after the golden run, "what about their billing for the month of
June?" and received the August-versus-July summary verbatim, formatted exactly
like an answer.

Two defects. The follow-up never checked whether the question was in scope; and
the fallback for an unanswerable question was `renderSummary` — the previous
conclusion with nothing marking it as a non-answer.

Notably the narrative guard worked: prose about June was rejected by the
`unknown_period` check added for finding 9. The fallback then undid the benefit.
A guard that catches a fabrication is only half the job — what replaces it has
to be honest too, and returning the last good answer is the most tempting wrong
choice available.

The wording mattered too: "the month of June" carries no year, and
`periodsMentioned` required one, so the scope check would not have fired on the
question as actually asked. It now takes an optional year, supplied from the
investigated periods where that context is unambiguous. `may` stays excluded
from bare-month matching — it is a verb far more often than a month here.

419 tests, up from 410. Mutation-checked: removing the scope check or the
"could not answer" preamble fails three.

---

### Found in manual testing — the reader's chosen periods were overridden

Asked "which two should I compare?" and answered "2026-06 and 2026-07", the
agent investigated 2026-07 against 2026-08 and presented the golden August
result as the answer.

Finding 9's fix checked that the model's periods *exist*. Both of these did, so
nothing objected. It never checked that they were the periods *asked for* —
which, on a clarification reply, is the entire content of the message.

The reader's text now wins: two available periods named explicitly are used
directly and the model's classification is discarded. The model still runs, for
case type and clarification, but does not overrule a stated choice. More than
two named asks which two; none named leaves the model in force.

Two existing tests changed meaning as a result, both in the right direction. The
golden question names August and July, so a model returning 2099-01/2099-02 is
now simply overridden rather than triggering a clarification — the old
expectation was rewritten and a no-periods-named case added to keep the original
behaviour covered. And a bare "May" is no longer read as a month, so a test
using "why did May jump against April?" now declines on April alone; it was
split into an explicit-years case and a bare-month case.

425 tests, up from 419. Mutation-checked: removing the override fails three.
Golden facts unchanged.

---

### Review recommendation — one investigation policy across all runners

> Golden fixtures can agree while a Workers AI repricing scenario receives
> different coverage.

Confirmed by probe before changing anything: with Workers AI repriced
mid-window, the pure-domain path returned `price_changed: false` where
production returned `true`. Real divergence, invisible to every existing test,
because the golden dataset reprices nothing.

Two changes. `src/domain/servicePolicy.ts` now owns which services are metered
and which is the driver, and all three paths read it. And the deterministic
runner stopped being a second implementation of the playbook — it calls
`runInvestigationTurn` with `DeterministicModelClient`, which deleted 291 lines
of parallel orchestration.

`analyseInvoiceVariance` stays independent on purpose, and I think this is the
line worth drawing: a second implementation of the *arithmetic* is a test, and
the cross-path equality assertion has caught drift repeatedly. A second
implementation of the *procedure* is a bug waiting for a dataset that can show
it. Share the policy, keep the maths independent.

Four existing assertions changed meaning, all in the same direction: the runner
now reports 11 steps rather than 9, 12 executions with one cache hit rather than
9 with none, both services' price versions rather than the driver's, and a
missing period is declined before a call is spent rather than failing on the
lookup.

430 tests, up from 425. Mutation-checked: reverting the domain path to the focus
service alone fails three parity tests. Golden facts unchanged.

One thing I got wrong on the way: I wrote the duplicate scenario as an *exact*
duplicate. Exact means a repeated `event_id`, which a primary key makes
unstorable — a copied event with a new id and an identical fingerprint is a
*probable* duplicate. The test caught it.
