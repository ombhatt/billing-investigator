# Architecture

How Billing Investigator is put together, and why it is put together that way.

The central constraint: **an LLM must never be able to produce a financial
figure, skip a check, or overstate confidence.** Most of what follows is a
consequence of taking that seriously rather than trusting the model to comply.

---

## 1. Components

```
                     ┌───────────────────────────────┐
   Browser  ───────► │  React UI (src/ui)            │
                     │  conversation · plan          │
                     │  evidence · summary           │
                     └──────────────┬────────────────┘
                          WebSocket │ HTTP /api/accounts/:id
                     ┌──────────────▼────────────────┐
                     │  Worker (src/server.ts)       │
                     │  routing · safe error mapping │
                     └──────────────┬────────────────┘
                     ┌──────────────▼────────────────┐
                     │  BillingInvestigatorAgent     │
                     │  (Durable Object)             │
                     │                               │
                     │   agent/loop.ts ──────────────┼──► ModelClient ──► Workers AI
                     │     playbook · limits         │    (classify /      Llama 3.3
                     │     state machine             │     plan / explain)
                     │     completion · confidence   │
                     │                               │
                     │   setState → synced record    │
                     │   this.sql → execution audit  │
                     └──────────────┬────────────────┘
                                    │ nine allowlisted tools
                     ┌──────────────▼────────────────┐
                     │  tools/ → repositories/       │
                     │  validation · account scoping │
                     │  prepared statements only     │
                     └──────────────┬────────────────┘
                     ┌──────────────▼────────────────┐
                     │  D1 — synthetic billing data  │
                     └───────────────────────────────┘

   domain/ is called by tools, agent and tests alike, and imports none of the above.
```

### Layer responsibilities

| Layer | Owns | Forbidden |
|---|---|---|
| `src/ui/` | Question, progress, evidence, summary | Showing chain-of-thought |
| `src/server.ts` | Routing, safe error shapes | Business logic |
| `src/agent/` | Playbook, bounded loop, completion, persistence | Computing money |
| `src/tools/` | Typed read-only operations, validation, scoping | Writing SQL |
| `src/repositories/` | Prepared-statement D1 access | String-built SQL |
| `src/domain/` | Money, rating, variance, change point, duplicates, reconciliation, confidence | Importing any Cloudflare binding |

That last row is load-bearing. Because `src/domain/` has no runtime
dependencies, every financial calculation is provable in plain Node — and a
static test enforces it.

---

## 2. The agent loop

One user turn:

```
 1. classify            ← model  (account discarded; periods validated against D1)
 2. get_account_context ← forced
 3. compare_invoices    ← forced        required prelude, fixed order
 4. decompose_variance  ← forced
 5. plan                ← model, ≤4 cycles
      selections filtered against the conditional allowlist
      may choose: get_usage_timeseries · get_price_versions
                  detect_usage_change_point · get_account_events
                  check_duplicate_usage
 6. reconcile_invoice   ← forced, outside the planning loop
 7. assess completion   ← server, from facts
 8. compute confidence  ← server, from facts
 9. explain             ← model, wording only
```

Bounds, all server-enforced: **12 tool calls**, **4 planning cycles**, one retry
and only for a failure the tool marked retryable. The golden path uses eleven
calls and one planning cycle — nine distinct tools, two of which run once per
metered service (§13).

### The model seam

Everything the model does goes through one interface:

```ts
interface ModelClient {
  classify(input): Promise<CaseClassification>;
  planNext(input): Promise<PlanUpdate>;
  explain(input): Promise<string>;
}
```

Two consequences:

- **Testability.** A scripted client drives the whole loop deterministically,
  so tests can assert what happens when the model misbehaves — selects an
  unknown tool, claims a different account, declares itself done early, throws.
- **Degradation.** `DeterministicModelClient` implements the same interface. If
  Workers AI is unreachable, the investigation still runs every check and still
  produces the correct fact block; only the prose changes. A test asserts this.

### State machine

```
                        ┌──────┐ reply still unclear
                        │      ▼
created ──► clarification_required ──► planning ──► investigating
                                          │              │
                                          └──────────────┤
                                                         ▼
                                                   reconciling
                                                    │       │
                                              completed   unresolved
```

There is **no edge from `investigating` to `completed`**. Reaching a
correctness claim without passing through `reconciling` is not a rule the model
is asked to respect — it is unrepresentable. Terminal states have no outgoing
edges, so a finished investigation cannot be resumed; the loop says so plainly
rather than failing deep inside.

---

## 3. Data model and lineage

Ten tables. Currency is `INTEGER` cents throughout; quantities are integers.

```
accounts ──┬── zones ──────────────┐
           ├── subscriptions       │
           ├── price_versions ─────┼───┐
           └── account_events      │   │
                                   │   │
usage_events ──(sum by day+zone)──► daily_usage
                                   │   │
                                   └───┴──(rate)──► rated_charges
                                                        │
                                          invoice_lines ┴─► invoices
```

Every hop keeps a reference back:

- `daily_usage` stores `source_event_count`, `source_event_first/last`
- `rated_charges` stores its `price_version_id` and the quantities used
- `invoice_lines` point at a `rated_charge_id` or a `subscription_id`
- every evidence card names its tool and the record IDs behind it

That lineage is what makes reconciliation meaningful rather than circular: each
boundary is **recomputed from its inputs** and compared to what is stored, so a
rated charge that disagrees with its own price version is caught.

```
stage_coverage                     every metered service present at all 4 stages
raw usage sum            vs  daily aggregate         (quantity)
daily aggregate          vs  rated quantity          (quantity)
rated_charge_internal_consistency  billable = max(0, consumed − included)
rated_charge_price_version         charge cites the version in force
recomputed charge        vs  stored rated charge     (cents)
stored rated charge      vs  invoice line            (cents)
invoice_line_linkage               each usage line references a real charge
fixed_fee_vs_subscription          each fixed line matches its subscription
subscription_active_for_period     that subscription was active in the period
invoice lines            vs  invoice subtotal        (cents)
invoice components       vs  invoice total           (cents)
```

Zero tolerance — a one-cent gap fails. Eight of these were added after review;
see §10 and §14. Twenty-two tests corrupt or remove one thing each and assert
the specific boundary that should notice it does.

---

## 4. Tool security boundary

The model produces a *tool name* and nothing else that reaches the data layer.
Arguments are built by the server from the investigation record.

```
model → tool name → allowlist check → server-built args → zod parse
      → account scope check → repository → prepared statement → D1
```

- **Allowlist.** `tools/registry.ts` maps names to handlers; anything absent
  cannot execute, whatever asks for it.
- **One wrapper, not nine.** `createTool` applies parsing, scope enforcement and
  safe error mapping once. Nine hand-rolled implementations would eventually
  differ in exactly the security-relevant step.
- **Account scoping.** Every tool checks its `accountId` against the account the
  investigation is bound to. Cross-account reads are denied, not filtered.
- **No SQL anywhere near the model.** Optional filters use fixed statement
  variants rather than concatenation; event types are filtered in code instead
  of a dynamic `IN` list.
- **Safe errors.** Stable machine code plus a message fit for a browser. No
  stack traces, no D1 errors, no SQL fragments.

Behavioural tests only prove the inputs they try, so `test/unit/sqlSafety.spec.ts`
adds static guarantees over the whole layer: only ALL-CAPS column constants may
be interpolated into a `prepare()` template, the tool layer contains no SQL at
all, and the read path contains no write statement.

---

## 5. State ownership

| State | Home | Why |
|---|---|---|
| Conversation messages | `AIChatAgent` (DO SQLite) | Provided by the SDK; survives refresh |
| Investigation record | `setState` on the DO | Synced to the UI, so plan/evidence/summary restore on reload |
| Tool-execution audit | `this.sql` on the DO | Bulky and append-only; no reason to sync it |
| Billing data | D1 | Shared, read-only, seedable |
| Model reasoning | **nowhere** | `PlanUpdate.reason` is read and dropped; a test asserts it never appears in the serialised record |

Investigation state is deliberately **not** in D1. The PRD lists those tables as
optional "if state is not entirely agent-local"; the Durable Object owns it, so
they would be a second source of truth.

Cloudflare Workflows is likewise unused. The DO already coordinates and persists
the investigation, and adding Workflows would split ownership of that state.

---

## 6. Failure modes

| Failure | Behaviour |
|---|---|
| Model unavailable or returns junk | Deterministic fallback per call; investigation completes with correct facts |
| Model classification unusable | Falls back to the two most recent seeded periods |
| Model picks an unknown tool | Dropped by the allowlist filter; loop continues |
| Model claims a different account | Discarded; the bound account stands |
| Model writes its own assessment | Detected and replaced with the deterministic summary |
| Tool fails transiently | One retry, only if the tool marked it retryable |
| Tool fails permanently | Step marked failed, blocker recorded, correctness cannot be claimed |
| Reconciliation fails | State becomes `unresolved`; confidence drops; the answer says so |
| Tool-call limit reached | Remaining steps skipped, blocker recorded, `unresolved` |
| Duplicate usage found | Treated as a material conflict; confidence `low` |
| Socket not yet open | Composer disabled — sending would drop the message silently |

The pattern throughout: degrade to *unresolved and honest*, never to *confident
and wrong*.

---

## 7. Tradeoffs

**Non-streaming responses.** Under `workers-ai-provider@3.3.1` with `ai@6`,
streamed tool-call argument deltas are appended rather than replaced, producing
`{"accountId": "{"accountId": "abcabc123"}123"}` — invalid JSON, so the tool
never runs and the model retries to the step limit. `generateText` is correct.
The provider fix requires `ai@7`, which `@cloudflare/ai-chat` does not yet
support. Live plan-step status covers the perceived-latency gap.

**Change-point detection extends the PRD.** The prescribed median-window scan
does not uniquely identify August 14: a five-day post-window reads as shifted
when only three of its days are, so medians tie across several dates and jitter
decides. An onset rule — the candidate day is in the new regime, the day before
is not — makes the answer unique and is what the question actually asks.

**One tool exposed to the model directly.** `buildTools()` still exposes only
`get_account_context` to the chat surface. The investigation runs through the
bounded loop instead, where selection is filtered and limits are enforced.

**Zone attribution is approximate.** A single-period series shows a zone's share
of *usage*, not of the *increase*. Closing that needs a second series call or a
per-zone change point.

---

## 8. Production evolution

Not implemented; this is where it would go next.

1. **Replace the synthetic adapter.** `domain/billableUsageView.ts` already
   emits public billable-usage field shapes, marking the seam where read-only
   billing, contract, deployment and support connectors would attach.
2. **Authorization.** Conversations are now separated per browser (§16), but the
   session id is an opaque label rather than an identity: it authenticates
   nobody and every visitor still reads the one bound account. Production needs
   enterprise RBAC and account-level authorization at the routing layer.
3. **Encrypt and minimise persisted customer data**, with retention on the
   durable object.
4. **Human approval** before case creation or any financial remediation — the
   read-only boundary is currently absolute, and should stay explicit when
   write paths appear.
5. **Evaluation gates.** Replay resolved investigations as a dataset; measure
   unsupported-claim rate and operator acceptance before any customer-facing
   explanation.
6. **More playbooks** — missing credits, suspected duplicates, pricing disputes,
   reconciliation failures — reusing the same required/conditional structure.
7. **AI Gateway** for inference observability, with a documented position on
   what it sees and how sensitive data is handled.
8. **Stronger anomaly detection** once labelled history exists; the transparent
   median scan is chosen for explainability, not accuracy.

---

## 9. Addendum: investigation state is server-owned

Found in review after M5.

The Agents SDK accepts `cf_agent_state` messages from any connected client and,
with its default no-op `validateStateChange`, persists the payload to
`cf_agents_state` and broadcasts it to every other connection. Nothing about
that is hidden — it is a reasonable default for collaborative agent state — but
it is the wrong default here.

This application's state is not collaborative. The investigation record carries
the totals, the completion verdict and the confidence rating. Left unguarded, a
browser could publish a fabricated `completed` investigation with invented
figures and `invoiceAppearsCorrect: true`, have it broadcast to every other
viewer, and have follow-ups answer from it as though it were evidence — routing
around the deterministic completion criteria entirely.

The original cause was ours: the Reset button called `agent.setState()` from the
client, which required that write channel to be open.

**Now:**

- `validateStateChange` throws for any source other than `"server"`
  (`src/agent/stateOwnership.ts`). The SDK responds `cf_agent_state_error` and
  neither persists nor broadcasts the update.
- Reset is a server-owned operation: the client `POST`s to
  `…/reset-investigation` on the agent, and the agent clears the record itself.
- `test/integration/stateOwnership.spec.ts` opens two real agent WebSockets,
  sends a forged `completed` record from one, and asserts the attacker is
  rejected, the other client receives nothing carrying it, and a fresh
  connection still syncs the untouched state. Removing the guard fails that test.

The general rule this is an instance of: **state a client can write is not
evidence.** Anything the product asserts as fact must be computed server-side
and must not be reachable through a client-writable channel.

---

## 10. Addendum: reconciliation could pass on a broken pipeline

Found in review after M5, alongside §9.

The original implementation enumerated services from raw and daily usage only,
then compared *recomputed* cost straight to the invoice line. Two consequences,
both reproduced before fixing:

- **With every usage row and rated charge deleted, it returned `passed`** with a
  single checkpoint. The per-service loop had nothing to iterate, so only the
  invoice-total check ran — and that tied out, because the invoice was intact.
  An invoice was certified correct with nothing behind it.
- **The stored rated charge was never examined.** Recomputation was compared to
  the invoice line, so corrupting `amountCents`, `priceVersionId`, or
  `billableQuantity` changed nothing. `subtotalCents` was never read at all.

That made the product's central guarantee — nothing is called correct without
reconciliation — hollow in exactly the cases it exists for.

**The rule now encoded: reconciliation must fail when a stage is *absent*, not
only when two present stages disagree.**

Services are enumerated across all four stages, so a service appearing at one
and missing from another is visible. Each stage is then verified independently:
raw → daily, daily → rated quantity, the charge's own billable arithmetic, the
price version it cites, recomputation → *stored* charge, stored charge → line,
line → charge linkage, lines → subtotal, subtotal → total.

Fixed-fee lines (Platform fee, R2, D1) are deliberately exempt from stage
coverage: they legitimately have an invoice line and no usage pipeline. Their
amounts still have to tie into the subtotal, and a test covers both halves.

PRD §12.9's four required boundaries are all still present; the additions are
strictly stronger. The golden scenario reconciles with all eighteen checkpoints
at zero, and the §20.4 fact block is unchanged.

---

## 11. Addendum: prose is held to the evidence

Found in review after M5, alongside §9 and §10.

The model writes the sentence a billing operator reads and pastes into a
customer email. Guarding the structured facts is therefore not enough: a
fabricated sentence above a correct fact table is still a wrong answer.

The original `usableFinding` rejected only empty text and a couple of section
labels — a guard built for a duplication problem seen live, not for fabrication.
Review demonstrated all four kinds passing through unchanged:

> "The invoice rose by $99,999 because dep-FAKE caused duplicate charges.
> The invoice is correct."

an amount absent from evidence, an identifier absent from evidence, causation
asserted for an event, and a correctness claim the model was not entitled to
make. Follow-ups accepted any non-empty prose at all.

**The rule now enforced: the model may only restate figures and identifiers that
already appear in verified evidence.** It still chooses what to say and how to
phrase it; it does not get to introduce new facts.

`src/agent/narrativeGuard.ts` builds an allowed vocabulary from the fact block
and the evidence cards, then checks the prose for:

| Check | Rejects |
|---|---|
| `unknown_amount` | a `$` figure not in evidence |
| `unknown_identifier` | a `dep-`/`inv-`/`price-`/`zone-`… id not in evidence |
| `unknown_percentage`, `unknown_date` | figures never computed |
| `asserted_causation` | a causal verb and an event id in the same sentence |
| `unearned_correctness` | a correctness claim when the invoice is not established correct |
| `confidence_claim` | a confidence level contradicting the computed one |
| `wrote_generated_sections` | prose writing the deterministic sections |

Rejection is all-or-nothing: one fabricated figure discredits the sentence it
sits in, so the deterministic finding is shown instead. Summary and follow-up go
through the same function.

Causation is judged per sentence, so "the rise was caused by higher request
volume" is fine while "dep-1842 caused the increase" is not. The guard was
verified against wording captured from a real Workers AI run — a guard that
rejected genuine output would silently degrade every answer to boilerplate,
which is why a test pins that exact sentence.

Bare quantities ("1,488 events") are not currently validated; only currency,
percentages, dates and identifiers are.

---

## 12. Addendum: unperformed diagnostics are not checked diagnostics

Found in review after M5, alongside §9–§11.

Only the prelude and reconciliation were ever *required*. Everything else —
pricing, usage shape, change point, operational correlation, duplication — was
conditional, and the model decided whether to run it. A model that ended
planning on the first cycle therefore reached `completed`, **`confidence: high`,
and zero blockers**, having examined none of it.

The mechanism that hid it: `(facts.exact_duplicate_count ?? 0)`. A `null`
meaning "never checked" became a `0` meaning "checked, none found", so the
conflict assessment read clean. Absence of evidence was being treated as
evidence of absence.

That contradicts PRD §10.5 rule 5 — when consumption materially changes, inspect
its time series, change point, operational events and possible duplicates.

**Which diagnostics are required is now derived from the deterministic variance,
not left to the model.** `applicableDiagnostics()` returns:

| Condition | Required |
|---|---|
| invoice variance ≠ 0 | `get_price_versions` |
| volume effect ≠ 0 | `get_usage_timeseries`, `detect_usage_change_point`, `check_duplicate_usage` |
| a change point was found | `get_account_events` |

Any of those missing is a blocker, which both prevents "appears correct" and
stops confidence reaching high. Duplicates can only be *cleared* by a duplicate
check that actually ran; unchecked stays unchecked.

This required `volume_effect_cents` and `price_effect_cents` in the fact block —
they are the deterministic signal for "consumption moved". Adding them meant
updating the golden assertions in all three paths, which is the system working
as intended: the three blocks are compared for exact equality, so a fact cannot
be added to one without the others noticing.

The model still chooses order, may add further checks, and may argue about what
it found. It cannot decide that a check the variance makes applicable is
unnecessary.

---

## 13. Addendum: diagnostic scope must match the claim's scope

Found in review after M5, alongside §9–§12.

`FOCUS_SERVICE` was a compile-time constant, `"Workers"`. Every diagnostic ran
against it, while the summary made **invoice-wide** statements. Two probes
showed what that produces:

| Reality | What the agent said |
|---|---|
| A Workers AI duplicate worth $4.13, propagated through every stage | "No exact or probable duplicate usage was found", confidence high |
| Workers AI rate tripled, invoice $22,380 | "Contract pricing did not change between the two periods", confidence high |

Both are false negatives on the checks the product exists to perform, and both
read as confident.

**The rule now encoded: an assertion about the invoice must be backed by a check
of the invoice.**

- Metered services come from the decomposition, which is the only stage that
  sees every service. Fixed-fee lines are excluded — they have no usage
  pipeline to check.
- `get_price_versions` and `check_duplicate_usage` run **once per metered
  service**, as plan steps identified `tool:service`.
- Facts accumulate rather than overwrite: `price_changed` is an OR across
  services, duplicate counts are a SUM. Previously the last service checked
  decided the invoice-wide answer.
- Completion requires the per-service ids, so a service left unchecked is a
  blocker.
- The investigative focus for the time series and change point is the largest
  absolute mover, derived rather than assumed. A test seeds the focus to `"R2"`
  — a fixed-fee line with no usage — and asserts it is corrected to `"Workers"`.

**Budget note.** The golden path now uses 11 of the 12 permitted tool calls. A
third metered service would exceed the limit, and the loop would mark the
remaining steps skipped and finish `unresolved` rather than assert something it
had not checked. That is the correct failure direction, but the headroom is thin
and PRD §10.6's limit would need revisiting before more services are seeded.

---

## 14. Addendum: a fixed fee is authorised by a subscription, not by an invoice

Found in review after M5, alongside §9–§13.

Raising August's platform fee by $100 while leaving its subscription untouched
produced `completed`, **100% explained**, high confidence, no blockers. The
invoice charged $6,100 for a fee authorised at $6,000.

The mechanism is subtle and worth stating plainly. The decomposition *correctly*
labelled the movement a fixed-fee effect, which made it **explained** — and
"explained" was being read as **valid**. Attribution is not authorisation. No
repository read the `subscriptions` table at all.

**Now:** `fixed_fee_vs_subscription` compares each fixed line to the monthly fee
its subscription authorises, and `subscription_active_for_period` requires that
subscription to be in force for the period — so an ended subscription still
billing, or one that has not started, fails.

### Charges that cannot be verified are named

R2 and D1 are illustrative flat charges in this dataset (PRD §13.5) with no
subscription behind them. Rather than silently treating them as validated,
reconciliation reports them in `unverifiedFixedCharges`, and completion blocks
"appears correct" if such a charge **moved** between periods — movement that
cannot be authorised must not be called explained.

They do not fail the golden invoice merely for existing, since they are static
there. The distinction is between *a charge we can check and did* and *a charge
we cannot check and have said so about*.

---

## 15. Addendum: overlap is not coverage

Found in review after M5, alongside §9–§14.

`effectivePrice` required exactly one *overlapping* price version, not one that
covered the window. A sole version effective from August 14 therefore rated
August 1-31: the first thirteen days were priced by a contract that did not yet
apply. A version ending early, or sitting only in the middle of the month, was
accepted the same way.

Invoice generation had its own copy of the overlap filter, so the same defect
existed in two places independently — which is why `generateRatedCharges` now
calls `effectivePrice` instead of repeating the logic.

**Now:** `covers()` requires the version to start on or before the window opens
and to remain in force until it closes. `effectivePrice` throws when the sole
candidate does not, naming the version and its dates:

```
price version price-workers-2026-01 covers 2026-08-14..open,
which does not span 2026-08-01..2026-08-31 for Workers
```

`coverageGap()` reports the same condition without throwing, and
`get_price_versions` surfaces it as a data limitation so an operator sees that
part of the window has no contracted price.

The distinction the code now makes explicit:

| Situation | Treated as |
|---|---|
| one version spanning the window | rate normally |
| two versions in the window | a price change (PRD §11.5) |
| one version not spanning the window | a coverage gap — refuse to rate |
| no version | no price — refuse to rate |

## 16. Addendum: one investigation per browser, and Reset that sticks

Review found the demo was a single shared conversation, and that Reset could be
undone by work that was already running.

**Every visitor shared one Durable Object.** The name passed to `useAgent` is the
DO instance id, and it was the constant `demo-abc123`. Two people opening the
deployed URL at once joined the same investigation: one saw the other's
questions appear, and either one's Reset cleared work the other was reading.
Each browser now keeps its own id in `localStorage` (`src/ui/session.ts`),
resolved once per load and stable across refreshes.

This separates conversations, not tenants. Every visitor still investigates the
single seeded `abc123`, so PRD §4.2's exclusion of multi-tenancy stands, and the
id is not authentication: it is opaque, grants nothing, and anyone holding it
reads the same read-only synthetic data. Only a value the app issued itself is
accepted back out of storage — the id is interpolated into the agent's routing
path, so a stored `../something` would address a different instance.

**A cancelled turn could still commit.** `clearHistory()` aborts the turn at the
transport, but the server-side turn is an ordinary awaited promise chain: when
the model call it was parked on finally resolved, it ran on and persisted its
record. The reader watched the cleared investigation reappear — plan, evidence,
verdict and all.

The conversation now carries a server-owned `generation`. Every reset advances
it; a turn captures the generation it opened in and commits only into that same
generation, and `onChatMessage` also honours the SDK's `abortSignal`, which it
previously ignored. The check sits immediately before `setState` with no `await`
between them, so it cannot be interleaved. Tool executions still reach the audit
trail — they genuinely ran — but the record does not come back.

The pattern is the same one findings 1–4 shared: a guarantee that held in the
present case and not in the absent one. Reset removed what was there; it had no
answer for what was still on its way.

## 17. Addendum: a clarification the agent cannot act on

Review found the agent could ask a question it was unable to hear the answer to.

Asked "which months?", answered "August versus July 2026", the reply branch did
this:

```ts
} else if (record.state === "clarification_required") {
  record = { ...record, state: transition(record.state, "planning") };
}
```

It moved to planning without reclassifying. `currentPeriod` and
`comparisonPeriod` were still null, `inputFor()` returns null without them, every
tool was skipped for want of an input, and the turn ended `unresolved` — the
reader having answered correctly. Classification ran only in the `created`
branch, so the one path that could set the periods was the one path a
clarification reply never took.

Both branches now go through `classifyPeriods`. A reply is classified against
the request it answers, not on its own: "August versus July 2026" names no
account and asks nothing, so the model receives the original question, the
question that was put to the reader, and the reply. `originalQuestion` is
persisted for exactly this, and survives the round trip so the synthesised
context is never mistaken for something the reader typed.

Re-asking is now a legal transition. `clarification_required` previously listed
only `planning` and `failed`, so a second unclear reply would have thrown
`InvalidTransition` — the fix above would have converted a wrong answer into a
crash.

### Unavailable periods are reported, not substituted

The same classification path silently replaced any period the account did not
have with the newest invoice:

```ts
const currentPeriod =
  classification && periods.includes(classification.currentPeriod)
    ? classification.currentPeriod
    : (sorted.at(-1) ?? null);
```

So "why did May jump?" became an investigation of August, reconciled, and
answered with high confidence. The wrong question answered correctly is worse
than no answer, because nothing in the output marks it as the wrong question.

Requested periods the account does not have are now named, alongside the ones it
does, and the investigation waits. Falling back to the two most recent invoices
survives in exactly one case — the model could not be reached at all, so nothing
was requested and nothing is being overridden.

One existing test asserted the old substitution as though it were the
requirement. It was rewritten rather than deleted: the comment now records that
review was right and why.

### The same defect, one layer lower

Deploying the above and testing it in production showed the fix was incomplete.
"Why did my May 2026 invoice jump compared to April 2026?" still returned a
reconciled, high-confidence answer — the panel correctly showing 2026-07 and
2026-08, the prose reading *"The May 2026 invoice jumped by $4,820.00 compared
to April 2026."*

Validating the model's answer was never going to be enough. Shown the available
periods, the live model does not report the months it was asked about and let
the server object; it quietly answers with the available ones instead. The
substitution happens *inside* the model, before any check of its output can see
it.

So the reader's own words are now checked first, against the invoices the
account actually has, before the model is consulted at all. Only the current
turn's text is parsed: the synthesised clarification context still quotes the
original request, so parsing that would re-raise the same objection forever and
the reader could never answer it.

The prose was the second half. Every amount in that sentence was real and every
identifier was real, so the narrative guard — which checks amounts, percentages,
ISO dates and identifiers — had nothing to object to. It was not checking what
the answer was *about*. `periodsMentioned()` (in `src/domain/period.ts`, so both
callers share one definition) now reads months in either spelling, and prose
naming a period that was not investigated is rejected like any other fabrication.

Two details that matter in the parsing: a full `2026-08-14` must not be read as
the period `2026-08`, or the golden narrative would be flagged on every run; and
"may" is only a month when a year sits beside it, or "this may indicate" becomes
a violation.

## 18. Addendum: a scan candidate is not a change point

Review found that constant usage produced a confirmed usage shift.

The scan always yields a best row. That was being returned as `detected: true`
unconditionally, so a flat 31-day series — every candidate tied at ratio 1.00 —
resolved to the earliest tie and reported:

```
2026-08-08: daily volume moved from 1,000 to 1,000 (1.00x)   [confirmed]
```

Nothing in the pipeline disagreed, because the qualifiers that said not to
believe it never travelled with the date. `applyToolFacts` kept `changeDate` and
discarded `ratio`, `material` and `confidence`, so downstream a rejected
candidate was indistinguishable from a real shift. The summary asserted "Usage
shifted on 2026-08-08", and `get_account_events` — whose window is anchored on
`facts.change_date` — then produced an operational-event correlation for a
change that had not happened.

Detection is now an acceptance, not a ranking. A change point is accepted when
the post/pre ratio departs from the baseline by the material factor in either
direction; a sustained fall is as real a change point as a rise, even though
only a rise carries a positive cost impact. A rejected scan still reports what
it looked at — `candidateDate`, the ratio, the points evaluated, and a reason
naming the candidate it declined — so "no change point" is an answer rather than
a silence.

The qualifiers now travel with the date on all three paths (domain case, tool
runner, agent). Adding `change_point_material` and `change_point_confidence` to
the fact block broke all three golden assertions at once, which is the
cross-path equality check behaving exactly as intended.

The shape is the one rule 21 already names, in a new place: a value that exists
is not a value that means something. The flat-series test that already existed
checked `material` and stopped there, never asking what the layers above did
with a date they should never have been given.
