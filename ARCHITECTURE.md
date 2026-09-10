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
and only for a failure the tool marked retryable. The golden path uses nine
calls and one planning cycle.

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
raw usage sum            vs  daily aggregate      (quantity)
daily aggregate          vs  rated quantity       (quantity)
recomputed rated charge  vs  invoice line         (cents)
invoice components       vs  invoice total        (cents)
```

Zero tolerance — a one-cent gap fails. Four tests inject exactly those defects
and assert each is caught.

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
2. **Per-investigation sessions and authorization.** Today one shared demo
   session and one bound account. Production needs enterprise RBAC and
   account-level authorization at the routing layer.
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
