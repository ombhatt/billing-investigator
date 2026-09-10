# Billing Investigator

A read-only AI agent that investigates invoice-variance complaints for Billing
Operations, built on Cloudflare Workers.

**Live demo:** https://billing-investigator.om-bhatt.workers.dev

> **All data here is synthetic and fictional.** Contract prices and internal
> pipeline boundaries are illustrative and do not reflect Cloudflare pricing.

---

## What it does

Given a vague complaint — *"why is our August bill higher, and is it correct?"* —
it runs a bounded diagnostic playbook rather than chatting over billing records:

1. Compares the two invoices and ranks the cost drivers
2. Separates consumption, price, fixed-fee, credit and tax effects
3. Inspects the driver's daily usage, contract pricing, change point, nearby
   operational events, and possible duplicate usage
4. Reconciles raw usage → rated charges → invoice lines → invoice total
5. Concludes, with a confidence rating it did not choose

The demo question resolves the full $4,820 variance to the cent, in about
twenty seconds and eleven tool calls — nine distinct tools, two of which run
once per metered service.

### The design decision that matters

**The LLM plans and explains. Deterministic TypeScript calculates and decides.**

The model never touches a tool. It is reached only through a three-method
interface — classify, plan, explain — and the server builds every tool input
itself. That makes the guarantees structural rather than a matter of the model
following instructions:

| Guarantee | How it is enforced |
|---|---|
| Cannot invent a figure | Facts are folded from tool output only; prose never becomes a number |
| Cannot run SQL | It has no tool access; every query is a prepared statement in the repository layer |
| Cannot skip reconciliation | Reconciliation runs outside the planning loop, and the state machine has no `investigating → completed` edge |
| Cannot inflate confidence | Confidence is computed from facts after the loop |
| Cannot widen scope | A model-supplied account id is discarded; the investigation is bound server-side |
| Cannot claim causation | Event proximity is evidence-typed `correlated`, never `confirmed` |

If the model is unavailable, every call has a deterministic fallback: the
investigation still completes and still produces the correct numbers — only the
prose degrades.

---

## Quick start

### Prerequisites

- Node.js 22+ (developed on 25.4)
- A Cloudflare account, and `npx wrangler login`

> Workers AI has **no local emulation**. `wrangler dev` proxies inference to
> Cloudflare, so a login is required even for local development, and the account
> needs a `workers.dev` subdomain (Cloudflare dashboard → Workers & Pages).

### Run locally

```bash
npm install
npx wrangler login              # required: Workers AI is remote-only
npm run db:migrate:local        # create the schema in local D1
npm run db:seed:local           # generate + load the synthetic dataset
npm run dev                     # http://localhost:5173
```

Then open http://localhost:5173 and click the suggested question.

### Verify without the app

```bash
npm run golden                  # golden facts from pure domain code, no LLM, no D1
npm run golden -- --full        # the complete analysis as JSON
npm run investigate             # the same facts, through the 9 tools against D1
```

### Checks

```bash
npm run typecheck
npm run lint
npm test                        # 353 tests
npm run test:unit               # domain only, plain Node
npm run test:integration        # tools + agent, Workers runtime
npm run build
```

### Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler d1 create billing-investigator   # first time only; copy the id
#   paste database_id into wrangler.jsonc

npm run db:migrate:remote
npm run db:seed:remote
npm run deploy
```

`npm run deploy` builds and publishes; the worker URL is printed at the end.

---

## The demo

**Ask:**

> Why is account abc123's August invoice higher than July, and is the bill correct?

**Expect** — every figure derived from seeded data, never hard-coded:

| | |
|---|---|
| July total | $16,900.00 |
| August total | $21,720.00 |
| Variance | **+$4,820.00 (28.5%)** |
| Workers | +$4,640.00 |
| Workers AI | +$180.00 |
| Price changed | no |
| Usage change date | 2026-08-14 |
| Correlated event | `dep-1842` (`edge-router-v3`) — correlation, not cause |
| Duplicates | 0 exact, 0 probable |
| Reconciliation | passed at all twelve boundaries |
| Variance explained | 100% |
| Confidence | high |

**Then ask a follow-up** — *"Could the usage have been duplicated?"* It answers
from persisted evidence with **no new tool calls**. Refresh the page and the
investigation is restored from the Durable Object.

**Reset demo** clears the conversation and investigation record, and ends any
turn still running — a reset investigation cannot be written back by work that
was already in flight. It never touches seeded billing data; every tool is
read-only.

Each browser gets its own investigation, so two people can read the deployed
demo at once without sharing a conversation.

---

## Cloudflare components, and why

| Component | Why |
|---|---|
| **Workers AI** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | Classification, conditional tool selection, explanation. Model id is configurable via the non-secret `MODEL_ID` var. |
| **Agents SDK + Durable Objects** | One durable object per investigation session: conversation, plan, evidence and summary survive refresh without a separate store. |
| **D1** | Synthetic billing data — accounts, zones, pricing, usage events, daily aggregates, rated charges, invoices, operational events. |
| **Workers + static assets** | Serves the React UI and routes agent traffic from one deployment. |

---

## Repository layout

```
src/
  domain/         pure calculation — imports no Cloudflare binding
  repositories/   prepared-statement D1 access
  tools/          nine typed read-only tools, allowlist, runner
  agent/          playbook, bounded loop, state machine, model seam
  ui/             React interface
seed/             deterministic synthetic data generator
migrations/       D1 schema
test/unit/        domain + static safety checks (plain Node)
test/integration/ tools + agent (Workers runtime, real D1)
docs/             PRD, build plan, build status
```

`src/domain/` is deliberately free of Cloudflare imports, which is what lets the
financial logic be proven in plain Node.

---

## Scope

**In scope (P0):** one account (`abc123`), one case type (`invoice_variance`),
July vs August 2026, nine read-only tools.

**Deliberately not built:** additional accounts or case types, escalation export,
charts, AI Gateway, Workflows, Vectorize, R2, authentication, RBAC, multi-tenancy.

**Known limitations:**

- Conversations are separated per browser, but tenancy is not: every visitor
  investigates the same seeded `abc123`, and the session id is an opaque label,
  not authentication. Production needs account-level authorization at the
  routing layer.
- Once an investigation completes, later questions are treated as follow-ups.
  Starting a new investigation requires **Reset demo**.
- Follow-ups run no new tools. PRD §7.4 allows a re-call for different
  granularity; instead the evidence is made sufficient during the investigation,
  so a question needing genuinely new data would be declined rather than
  answered.
- Token-level streaming is not used: the Workers AI provider corrupts streamed
  tool-call arguments at the pinned versions. See `docs/BUILD_STATUS.md`.

---

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components, agent loop, data lineage,
  security boundary, state ownership, failure modes, production evolution.
  §9–§16 are addenda: one per external code-review finding, each recording what
  the defect was and why the fix takes the shape it does.
- [`docs/PRD.md`](./docs/PRD.md) — the product requirements this was built against
- [`docs/BUILD_PLAN.md`](./docs/BUILD_PLAN.md) — how P0 was scoped down
- [`docs/BUILD_STATUS.md`](./docs/BUILD_STATUS.md) — milestone status, spike
  outcomes, and every deviation from the PRD with its rationale
- [`PROMPT_HISTORY.md`](./PROMPT_HISTORY.md) — the AI-assisted build record
- [`CLAUDE.md`](./CLAUDE.md) — the standing rules this codebase is held to
