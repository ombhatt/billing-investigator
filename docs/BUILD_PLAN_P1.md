# Build Plan — P1.1: the duplicated-usage account

**Derived from:** `docs/PRD.md` §6.2 · **Companion:** `docs/BUILD_PLAN.md` (P0, complete)
**Status:** Plan only. No implementation has started.
**Milestone numbering** continues from the P0 plan, which ended at Milestone 5.

---

## Context

P0 proved the system can say **"this bill is correct."** Every golden fact ends in
agreement: reconciliation passed, 100% of the variance explained, zero duplicates,
confidence high.

It has never said the other thing. `agent.spec.ts` does reach `unresolved` and
`invoiceAppearsCorrect: false`, but through constructed conditions — a tool-call limit, a
missing diagnostic. There is no **seeded account a person can open the demo and ask about**
where the honest answer is no. That is the gap this milestone closes, and it is why this
runs ahead of the missing-credit account the PRD lists first.

It is also the cheaper of the two. The machinery already exists and is wired end to end:

- `check_duplicate_usage` runs once per metered service on every investigation and has
  never returned anything but `0 exact, 0 probable`.
- `assessCompletion` already turns a non-zero count into `materialConflict`, a blocker, and
  `invoiceAppearsCorrect: false`.
- `evaluateConfidence` already forces `low` on a material conflict, and its own doc comment
  describes the trigger as *"a duplicate that the invoice bills"* — this exact scenario.

Nothing in `src/domain/` needs a new concept. The work is seed data, account plumbing, and
a second pinned fact block.

---

## 1. The scenario

**Acme's sibling account is billed twice for one batch of traffic.** An ingestion replay
wrote a second copy of a run of usage events. The rollup summed both copies, the rating
engine priced what the rollup said, and the invoice states that total faithfully.

The bill is arithmetically perfect and substantively wrong.

### 1.1 Why the duplicate must flow all the way through

There are two places the duplicate could stop, and they are different scenarios:

| Where the copy lands | What reconciliation says | What it demonstrates |
|---|---|---|
| **`usage_events` → `daily_usage` → rated → invoice** | **passes** — every boundary ties | A passing reconciliation is not proof the bill is right |
| `usage_events` only, not rolled up | fails at `raw_usage_vs_daily_aggregate` | A pipeline discrepancy (H6) |

**Build the first.** It is the sharper scenario and the one the golden account cannot make:
it shows why PRD rule 7 has three clauses rather than one. Reconciliation passing, and the
variance being fully explained, are both true here — and the invoice is still not correct,
because a material discrepancy is unresolved.

The second is a legitimate future scenario. It is not this one, and conflating them would
produce a case that proves neither.

### 1.2 What the duplicate has to look like

`usage_events.event_id` is the primary key, so **an exact duplicate is unstorable** — a
repeated `event_id` cannot exist in D1. This account therefore seeds *probable* duplicates,
which is also the realistic shape: a replay assigns fresh event ids to the same source
records.

`fingerprint()` hashes:

```
account_id | service_name | zone_id | source_event_key | timestamp_bucket(60s) | quantity | unit
```

So each seeded copy carries a **new `event_id`** and an **identical `source_event_key`**,
same zone, same quantity and unit, within the same 60-second bucket. `source_event_key`
matching is what makes the story a replay rather than a coincidence.

`daily_usage.source_event_count` must include the copies, and `source_event_first` /
`source_event_last` must still bound them, or the lineage columns contradict the rollup and
the wrong boundary fails.

### 1.3 Deliberately held constant

The second account keeps **the same two metered services** (`Workers`, `Workers AI`) and the
same period set as `abc123`.

This is not laziness. `InvestigationFacts` has service names in its type —
`workers_variance_cents`, `workers_ai_variance_cents` — so an account with a different
service catalogue needs that type restructured into a discriminated union first. That is a
larger piece of work, it is shared with any second *playbook*, and dragging it into this
milestone would make a data change into a type-system change. Keep them separate.

---

## 2. Milestones

Five, each independently verifiable without work from a later one.

---

### Milestone 6 — Seed parameterisation with no golden drift

**Goal:** The generator produces N accounts, and `abc123`'s bytes do not move.

`generateSyntheticData` closes over a single `ACCOUNT` const and one `mulberry32(SEED)`
stream. Drawing a second account from that same stream would shift `abc123`'s values
depending on generation order — silently breaking the golden fact block that every layer
asserts.

**Each account gets its own PRNG stream, derived from its own seed constant.** Account
order must not be able to affect account content.

**Files**

```
seed/constants.ts              ACCOUNT -> ACCOUNTS, one seed per account
seed/generateSyntheticData.ts  per-account generation, no shared draws
seed/emitSql.ts                emit N accounts
test/unit/seed.spec.ts         extend
```

**Acceptance**

- `npm run seed:build` twice → byte-identical output (rule 13, unchanged)
- `shasum .seed/golden.sql` for `abc123`'s rows matches the pre-change value
- `npm run golden` prints the P0 fact block **unchanged**
- Generating accounts in reverse order produces identical per-account output
- No new Cloudflare service (no `docs/BUILD_PLAN.md` update needed)

**Check:** this milestone is done when the second account does not exist yet and every
existing test still passes.

---

### Milestone 7 — The account, in data

**Goal:** The scenario is true in D1 and provable with no agent and no model.

**Files**

```
seed/constants.ts              the duplicated-usage account's figures
seed/generateSyntheticData.ts  the replayed event run
test/unit/duplicates.spec.ts   extend to the seeded shape
test/integration/tools.spec.ts check_duplicate_usage against the new account
```

**Acceptance**

- `check_duplicate_usage` on the new account returns `probable_duplicate_count >= 1`,
  `exact_duplicate_count = 0`
- The report's `duplicateQuantity` counts **surplus copies only**, never the whole group —
  the first occurrence is legitimate
- `reconcile_invoice` **passes** at all twelve boundaries, including
  `raw_usage_vs_daily_aggregate`
- The duplicate's estimated cost is priced at the overage rate and is material against the
  invoice total
- `abc123`'s tool results are untouched

**Manual verification**

```bash
npm run db:seed:local
npm run investigate        # golden account: unchanged
```

---

### Milestone 8 — The account stops being a constant

**Goal:** An investigation is bound to an account chosen at open, and a tool still cannot
read any other one.

This is the highest-risk milestone in the plan and the only one that touches a security
invariant. `INVESTIGATION_ACCOUNT_ID` is a module constant in `src/server.ts` today, which
is what makes rule 5 trivially true.

**The account is bound server-side when the investigation opens and is read from the
investigation record on every subsequent call — never from client input per call.** A
picker may tell the server which account to *open*; it may never accompany a tool call.
`createTool`'s scope check stays exactly as it is and remains the backstop.

**Files**

```
src/server.ts                      bind at open, drop the constant
src/agent/loop.ts                  focusService likewise stops being a constant
test/integration/tools.spec.ts     cross-account denial, per account
test/integration/sessionIsolation.spec.ts   two sessions, two accounts, no bleed
```

**Acceptance**

- A tool called with account B inside an investigation bound to account A is **denied**
  with `ACCOUNT_SCOPE_VIOLATION` — asserted for every tool on the allowlist, both directions
- A client-supplied account id on a turn **cannot** change the bound account of a live
  investigation
- Two concurrent sessions on different accounts never see each other's evidence
- `FOCUS_SERVICE` is derived, not assumed (`pickFocusService` already does this; the
  constant is the fallback and must not be account-specific)

**Mutation check:** re-point the bound account mid-investigation in a test and confirm the
scope denial fires rather than the read succeeding.

---

### Milestone 9 — The verdict the system has never given

**Goal:** A full agent turn on the new account concludes **not correct**, with evidence.

**Acceptance — the second fact block**

Pinned in `CLAUDE.md` beside the golden block once the figures exist. Its *shape* is fixed
now; the numbers are whatever M7's seed produces and must not be invented ahead of it:

```
exact_duplicate_count    = 0
probable_duplicate_count >= 1
reconciliation_status    = passed        <- note: passed, and still not correct
explained_percent        >= 95
invoiceAppearsCorrect    = false
confidence               = low           <- forced by materialConflict
blockers                 contains "duplicate usage group(s) found"
```

- The turn reaches state `unresolved`, not `completed`
- `check_duplicate_usage` ran **on every metered service** before any invoice-wide claim
  (invariant 23)
- The narrative names the duplicate, its services and its cost, and every figure in it
  appears in evidence — or `safeNarrative` discards the whole sentence (invariant 25)
- The narrative does **not** describe the duplicate as the proven cause of the variance
  unless the decomposition says so (invariant 8)
- `abc123`'s golden E2E asserts its own block, unchanged

---

### Milestone 10 — Choosing an account, and the demo

**Goal:** A reader can pick the account and watch the system decline to bless a bill.

**Files**

```
src/ui/App.tsx, AccountHeader.tsx   account selection
src/ui/types.ts
docs/HOW_IT_WORKS.md                a second scenario paragraph
README.md                           the second account in the demo script
```

**Acceptance**

- Switching account starts a **new investigation**; it never mutates a running one
- The synthetic-data disclosure holds for both accounts (rule 14)
- A PRD §20.5-shaped manual pass on the new account against the deployed URL
- Reset still leaves both accounts' seeded billing data unchanged

---

## 3. Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Golden drift** | A shared PRNG stream makes account content order-dependent; the fact block is asserted by three layers and would fail loudly but confusingly | Per-account seed (M6), and M6 lands before any second account exists |
| **Account-scope regression** | Lifting a constant is exactly how a scoping guarantee quietly becomes conditional | M8's denial tests run over the whole allowlist, both directions, plus a mutation check |
| **The facts type** | Service names are baked into `InvestigationFacts` | Hold the service catalogue constant (§1.3); restructure only when a second playbook forces it |
| **Scenario collapse** | Seeding the duplicate so it *fails* reconciliation turns this into a pipeline-discrepancy case and proves neither thing | §1.1 is an acceptance criterion, not a preference: reconciliation must pass |
| **A demo that only ever says no** | Two accounts, two verdicts — the pair is the point | Keep `abc123` the default landing account |

---

## 4. Definition of done

Everything in `CLAUDE.md` § Definition of done, plus:

- [ ] `abc123`'s fact block byte-identical; `.seed/golden.sql` reproducible across runs
- [ ] The second account's block pinned in `CLAUDE.md` and asserted by a test
- [ ] Cross-account denial tested for every tool, both directions
- [ ] Reconciliation **passes** on the duplicated-usage account
- [ ] The verdict is `false` with confidence `low` and a duplicate blocker
- [ ] `docs/BUILD_STATUS.md` reflects reality
- [ ] `PROMPT_HISTORY.md` records the prompt and outcome

---

## 5. Explicitly not in this milestone

The missing-credit account (it needs an entitlement record before absence can be asserted
at all — rule 21), escalation export, AI Gateway, the cost-driver chart, any second case
type, and any restructuring of `InvestigationFacts`.

---

All data remains synthetic and fictional. The application stays read-only at every
priority: duplicates are **reported, never removed**, and no credit, refund or correction is
ever issued.
