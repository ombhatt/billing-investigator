# Product Requirements Document: AI Billing Investigator

**Version:** 1.0  
**Date:** September 9, 2026  
**Status:** Build-ready MVP specification  
**Primary audience:** Coding agent implementing the Cloudflare job application assignment  
**Working title:** Billing Investigator  

---

## 0. Coding-agent mandate

Build a deployable, polished MVP of the product described in this PRD. Treat every P0 requirement and acceptance criterion as required. P1 items are optional only after all P0 behavior is complete and tested.

The finished repository must:

1. Run locally with documented commands.
2. Deploy to Cloudflare.
3. Use Cloudflare Workers AI with `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default.
4. Use Cloudflare Agents SDK/Durable Objects for the chat session and persistent investigation state.
5. Use D1 for synthetic billing and operational data.
6. Use LLM tool calling to orchestrate deterministic, read-only billing tools.
7. Produce auditable answers derived from data, never prewritten answers.
8. Include automated tests for all billing calculations and the golden investigation.
9. Include `README.md`, `ARCHITECTURE.md`, and `PROMPT_HISTORY.md`.
10. Clearly label all customer, contract, pricing, usage, and invoice data as synthetic.

Do not add production billing integrations, payment processing, write operations, authentication, refunds, or invoice corrections. Do not let the LLM execute arbitrary SQL or calculate authoritative financial totals.

If a Cloudflare API or SDK has changed, use the current documented equivalent while preserving the requirements and behavior in this PRD. Record any material deviation in `ARCHITECTURE.md`.

---

## 1. Executive summary

Billing Investigator is a read-only AI agent for Billing Operations and Customer Support teams. It investigates ambiguous billing complaints such as:

> “Why is account `abc123`’s August invoice $4,820 higher than July, and is the bill correct?”

The product is not a general chatbot over billing records. It automates a bounded billing investigation:

1. Classifies the question.
2. Creates a visible investigation plan.
3. Uses deterministic tools to compare invoices, decompose the variance, inspect usage and pricing, detect a change point, retrieve relevant account events, check duplicate usage, and reconcile billing stages.
4. Tests competing hypotheses.
5. Produces an evidence-backed conclusion with confidence and recommended next steps.
6. Persists the conversation, plan, tool results, and conclusion for follow-up questions.

The MVP demonstrates practical AI fluency and sound financial-platform judgment: the LLM handles ambiguity, planning, branching, and explanation; trusted application code performs currency math, reconciliation, anomaly detection, and evidence generation.

---

## 2. Problem statement

Billing questions commonly begin as vague customer complaints:

- “My bill went up.”
- “This usage looks wrong.”
- “Were we charged twice?”
- “Did our price change?”

Resolving one complaint can require a support or billing operator to navigate multiple datasets, compare billing periods, identify material cost drivers, inspect contract versions, find usage changes, correlate them with operational events, test for duplicates, and reconcile raw usage through invoice generation.

This work is slow and inconsistent because the operator must know which checks to run, in which order, and when enough evidence exists to reach a conclusion. A simple conversational interface does not solve this problem if it only retrieves and summarizes data.

Billing Investigator adds value by encoding a proven investigation playbook and applying it adaptively to a specific account and question.

---

## 3. Product principles

1. **Investigate, do not merely retrieve.** Each response should advance or complete a diagnostic process.
2. **Deterministic money, probabilistic language.** All financial calculations and checks run in code; the LLM explains their results.
3. **Evidence before conclusion.** Every material finding links to source records or deterministic tool output.
4. **Bounded autonomy.** The agent chooses only from allowlisted, read-only tools and follows a defined playbook.
5. **Visible reasoning process.** Show the investigation steps and evidence without exposing private chain-of-thought.
6. **Honest uncertainty.** Distinguish confirmed facts, correlations, hypotheses, and missing data.
7. **Read-only by default.** The MVP must never change contracts, usage, invoices, credits, or payments.
8. **Synthetic but internally consistent.** Demo data may be fictional; all displayed results must be derived correctly from it.

---

## 4. Goals, non-goals, and success measures

### 4.1 P0 goals

- Support a complete `invoice_variance` investigation for synthetic account `abc123`.
- Allow a user to begin with a natural-language question.
- Demonstrate an adaptive agent loop using LLM tool calling.
- Explain exactly why August differs from July.
- Determine whether the August invoice reconciles with underlying rated usage.
- Show evidence, progress, and a final resolution summary.
- Preserve investigation state across page refreshes and follow-up questions.
- Demonstrate Cloudflare-native implementation.

### 4.2 Non-goals

- General-purpose querying of every billing field.
- Production Cloudflare account integration.
- Actual Cloudflare enterprise pricing replication.
- Authentication, RBAC, or multi-tenancy.
- Tax calculation.
- Revenue recognition.
- Payment capture, disputes, or collections.
- Refund, credit, contract, or invoice write operations.
- Voice input.
- Training or fine-tuning a model.
- A comprehensive anomaly-detection platform.
- Proving causation between deployments and usage changes.

### 4.3 Demo success measures

The MVP is successful when:

- The golden investigation explains 100% of the $4,820 invoice variance.
- All currency totals reconcile to the cent.
- The final answer identifies Workers usage as the primary driver.
- The final answer reports that pricing did not change.
- The final answer identifies the August 14 deployment as temporally correlated, not proven causal.
- The final answer reports that no duplicate usage was found.
- The final answer reports that raw usage, rated charges, and the invoice reconcile.
- Each material claim has visible evidence.
- A follow-up question uses the existing investigation context without restarting.
- A reviewer can run the project and complete the golden flow without creating data manually.

### 4.4 Product success metrics for a hypothetical production rollout

These are product hypotheses, not MVP telemetry targets:

- Reduce median billing-investigation time from 30–60 minutes to under 5 minutes.
- Reduce unnecessary engineering escalations by at least 30%.
- Explain at least 95% of invoice variance before declaring a case resolved.
- Achieve zero unsupported financial calculations in generated answers.
- Preserve a complete audit record of tools called and evidence used.

---

## 5. Users and primary job to be done

### 5.1 Primary persona: Billing Operations specialist

The user understands invoices and customer accounts but may not know the underlying product telemetry or billing pipeline. The user needs to determine quickly whether an invoice is correct and how to explain it.

**Job to be done:**

> When a customer challenges an invoice, help me identify and verify the reason for the change so I can respond accurately or escalate with complete evidence.

### 5.2 Secondary persona: Customer Support engineer

The user owns a customer escalation and wants a reliable explanation without manually consulting Billing Engineering, Product Engineering, and Finance.

### 5.3 Demo user

No authentication is required. Treat the local/demo user as an authorized internal operator with read access to all synthetic accounts.

---

## 6. Scope and prioritization

### 6.1 P0: required

- One fully implemented case type: `invoice_variance`.
- One fully seeded golden account: `abc123` / Acme Corp.
- Invoice comparison for July and August 2026.
- Variance decomposition by service and cause.
- Usage comparison and daily time series.
- Effective price inspection.
- Change-point detection.
- Account/deployment-event lookup.
- Duplicate-usage check.
- Raw usage → rated charge → invoice reconciliation.
- Evidence-backed final response.
- Persistent investigation/chat state.
- Suggested prompts and one-click demo start.
- Investigation reset.
- Unit, integration, and golden-path end-to-end tests.

### 6.2 P1: implement only after P0 is complete

- A second account with a missing-credit scenario.
- A third account with duplicated usage.
- Export/copy a structured escalation summary.
- AI Gateway integration for inference observability.
- A small cost-driver chart.

### 6.3 P2: explicitly deferred

- Production API integration.
- Human approval for financial adjustments.
- Slack or email channel.
- Forecasting.
- Enterprise contract ingestion.
- Automated case creation.
- Vector search over policies or contract documents.

---

## 7. Golden user journey

### 7.1 Entry

The landing page shows:

- Product name and one-sentence purpose.
- A visible “Synthetic demo data” badge.
- Account selector defaulted to `abc123 — Acme Corp.`
- Suggested prompt:

> Why is account abc123’s August invoice higher than July, and is the bill correct?

- A primary button: **Investigate invoice**.

### 7.2 Investigation

After submission, the UI immediately creates an investigation and displays a progress plan. The user sees concise status updates such as:

1. Comparing July and August invoices
2. Separating usage, price, credit, and tax effects
3. Inspecting Workers usage change
4. Checking price and account events
5. Checking duplicate usage
6. Reconciling usage with the invoice
7. Preparing conclusion

Do not display private model reasoning. Display only tool names translated into user-friendly actions, tool status, deterministic results, and evidence.

### 7.3 Final answer

The expected meaning of the final answer is:

> Acme Corp.’s August invoice increased by **$4,820 (28.5%)**, from **$16,900** to **$21,720**. **$4,640** came from additional Workers requests and **$180** came from additional Workers AI usage. Workers request volume increased from **1.00 billion** to **1.58 billion**, while its price remained unchanged. The increase began on **August 14**, shortly after deployment `edge-router-v3` in zone `api.acme.example`. No exact or probable duplicate usage was found, and raw usage, rated charges, and invoice line items reconcile to the cent. The invoice therefore appears correct. The deployment is strongly correlated with the usage increase, but the available data does not prove causation.

Recommended next step:

> Confirm with the application owner whether the traffic generated after `edge-router-v3` was expected.

The wording can vary, but all amounts, qualifications, and conclusions above must remain correct.

### 7.4 Follow-up questions

The persisted session must correctly answer:

- “Did the customer’s Workers price change?”
- “Could the usage have been duplicated?”
- “Which zone generated the increase?”
- “What happened on August 14?”
- “Can you summarize this for the customer?”

Follow-up answers must reuse existing tool results where they remain sufficient. The agent may call a tool again only if different granularity or missing evidence is required.

---

## 8. User experience requirements

### 8.1 Layout

Use a responsive two-column desktop layout:

- **Left, approximately 55%:** conversation and message composer.
- **Right, approximately 45%:** investigation details.

On narrow screens, stack conversation above investigation details.

The investigation panel contains three tabs:

1. **Plan:** steps, status, and concise outcome.
2. **Evidence:** source-backed facts and calculations.
3. **Summary:** final conclusion, confidence, and next action.

### 8.2 Conversation behavior

- Stream or progressively display the final response if supported by the selected SDK path.
- Disable duplicate submissions while the agent is processing.
- Allow the user to send a follow-up after completion.
- Show a clear error with retry when inference or a tool fails.
- Never expose raw chain-of-thought.
- Tool activity may appear as compact events such as “Compared invoices” or “Reconciliation passed.”

### 8.3 Evidence cards

Each evidence card must include:

- Finding label
- Value
- Source/tool name
- Relevant record IDs
- Billing period or timestamp
- Status: `confirmed`, `correlated`, `not_found`, or `unresolved`

Example:

```text
Workers price change
No price change found
Source: get_price_versions
Price version: price-workers-2026-01
Effective: 2026-01-01 onward
Status: confirmed
```

### 8.4 Visual design

- Professional internal-tool aesthetic.
- High information density without clutter.
- Accessible color contrast and keyboard navigation.
- Do not rely on color alone for status.
- Use monospaced styling for account, invoice, deployment, zone, and record identifiers.
- Use skeletons or progress indicators during investigation.
- Avoid decorative animation that distracts from evidence.

### 8.5 Empty, loading, and error states

- **Empty:** Show suggested prompt and account overview.
- **Loading:** Show the current investigation step.
- **No data:** State which source or period has no data.
- **Tool failure:** Mark the step failed, retain completed evidence, and allow retry.
- **LLM failure:** Preserve tool results and show a deterministic fallback summary if enough evidence exists.
- **Unresolved:** Explicitly state that the invoice cannot be validated from available data.

---

## 9. Functional requirements

### FR-1: Account selection

- The user can select `abc123 — Acme Corp.`.
- The account header shows account ID, company name, plan type, currency, and “Synthetic” badge.
- Unknown account IDs return a safe `404`-style response and are not passed into arbitrary SQL.

### FR-2: Start investigation

- The user can submit the suggested prompt or type an equivalent question.
- The system creates an `investigation_id` and associates it with the account.
- The agent extracts or confirms the current and comparison billing periods.
- If the account or periods are missing, ask a concise clarification instead of guessing.

### FR-3: Classify the case

- P0 supports only `invoice_variance`.
- Questions within scope are normalized to this case type.
- Out-of-scope questions receive a transparent response listing supported behavior.

### FR-4: Create a bounded plan

- The agent creates an initial structured plan using the invoice-variance playbook.
- Required checks cannot be removed by the LLM.
- Conditional checks may be selected based on tool results.
- The UI displays plan steps, not private reasoning.

### FR-5: Execute tools

- The agent may call only allowlisted read-only tools.
- Every call is validated server-side.
- Every result is persisted with timestamps and evidence IDs.
- Exact repeated calls with identical arguments should use a cached persisted result within the investigation.
- Maximum tool calls per user turn: 12.

### FR-6: Compare and decompose invoices

- Compare invoice totals and service-level lines.
- Return absolute and percentage change.
- Explain the variance by service.
- Separate volume, price, fixed fee, credit, and tax effects where present.
- Use integer cents for all currency math.

### FR-7: Inspect usage and prices

- Retrieve daily usage for a selected service and period.
- Compare current and prior-period quantities.
- Retrieve all price versions overlapping the requested period.
- Calculate whether price changed during or between periods.

### FR-8: Detect operational correlation

- Detect a material usage change point.
- Retrieve account, deployment, subscription, and configuration events near that time.
- Report temporal proximity.
- Never label correlation as proven causation.

### FR-9: Check duplicate usage

- Detect exact duplicates by `event_id`.
- Detect probable duplicates by a deterministic fingerprint.
- Return counts, affected quantity, and estimated financial impact.
- The golden scenario returns zero exact and zero probable duplicates.

### FR-10: Reconcile the invoice

- Compare aggregated raw usage to rated quantities.
- Compare rated cost to invoice usage lines.
- Compare calculated invoice composition to final invoice total.
- Report differences in cents at each boundary.
- Golden scenario differences must all equal zero.

### FR-11: Complete or escalate

The agent may declare the invoice “appears correct” only when:

- At least 95% of variance is explained.
- Reconciliation has completed.
- No unresolved material discrepancy exists.
- Required checks have succeeded.

Otherwise, it must state that the investigation is unresolved and identify the missing or conflicting evidence.

### FR-12: Persist state

Persist:

- Conversation messages
- Case classification
- Account and periods
- Plan and step statuses
- Tool calls and results
- Evidence cards
- Completion metrics
- Final summary

Refreshing the page or reconnecting to the same investigation must restore this state.

### FR-13: Reset demo

- A **Reset demo** action starts a new investigation session.
- Reset must not mutate seeded billing data.

### FR-14: Synthetic-data disclosure

- Show disclosure in the landing view and footer/about area.
- README must explain which terminology is public and which prices/system boundaries are illustrative.

---

## 10. Agent design

### 10.1 Architecture choice

Use the Cloudflare Agents SDK for the durable agent/session runtime. Use the SDK’s Durable Object-backed state for the conversation and investigation record. Use Workers AI through an AI binding with:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

Use tool calling. If the Agents SDK starter provides a reliable chat and tool loop, extend it rather than implementing WebSocket/session behavior from scratch.

Use D1 for shared synthetic billing data. Agent-local durable state and D1 business data serve different purposes and should remain separate.

### 10.2 Hybrid planning model

The LLM does not invent the entire investigation process. The application supplies a fixed `invoice_variance` playbook.

The LLM is responsible for:

- Interpreting the user’s question.
- Extracting account and periods.
- Selecting conditional diagnostic tools.
- Forming and updating hypotheses.
- Explaining structured results.

Application code is responsible for:

- Required plan steps.
- Tool allowlisting and validation.
- Currency and quantity calculations.
- Completion criteria.
- Evidence status.
- Tool-call and iteration limits.

### 10.3 Investigation state machine

Supported states:

```text
created
clarification_required
planning
investigating
reconciling
completed
unresolved
failed
```

Valid high-level transitions:

```text
created -> clarification_required -> planning
created -> planning
planning -> investigating
investigating -> reconciling
reconciling -> completed
reconciling -> unresolved
any active state -> failed
failed -> previous active state on retry
```

### 10.4 Hypothesis set

For invoice variance, initialize these hypotheses:

```text
H1: Consumption changed.
H2: Effective price changed.
H3: Subscription or entitlement changed.
H4: Credit or tax treatment changed.
H5: Usage was duplicated or omitted.
H6: Rating or invoice generation introduced a discrepancy.
```

Each hypothesis has status:

```text
untested | supported | rejected | unresolved
```

The state visible to the UI may show labels and status but must not expose hidden model reasoning.

### 10.5 Required system prompt behavior

Implement a version-controlled system prompt with the following semantic requirements:

```text
You are a read-only billing investigation agent for internal Billing Operations.

Your purpose is to diagnose invoice-variance questions using only the supplied tools and persisted evidence.

Rules:
1. Never perform authoritative arithmetic yourself; use deterministic tools.
2. Never claim an invoice is correct until reconciliation succeeds.
3. Start invoice-variance cases by comparing invoices and decomposing the variance.
4. Separate consumption, price, subscription, credit, tax, and pipeline effects.
5. When consumption materially changes, inspect its time series, change point, operational events, and possible duplicates.
6. When pricing changes, retrieve the effective price versions and dates.
7. Describe temporal relationships as correlation unless a tool provides causal evidence.
8. Support every material claim with evidence returned by a tool.
9. Do not fabricate records, amounts, identifiers, dates, tools, or tool results.
10. If evidence conflicts or is missing, say the investigation is unresolved.
11. Keep the final response concise and structured as Finding, Evidence, Assessment, and Recommended next step.
12. All data is synthetic; mention this only when relevant to the demo, not repeatedly in every sentence.
```

Do not include the expected golden conclusion or `$4,820` in the system prompt.

### 10.6 Agent loop

1. Receive message and current investigation state.
2. Classify or reuse case type.
3. Determine required/conditional next tools.
4. Submit tool call.
5. Server validates and executes.
6. Persist tool result and evidence.
7. Update plan and hypothesis statuses using structured output.
8. Evaluate deterministic completion criteria.
9. Continue, conclude, or report unresolved.

Maximum limits:

- 12 tool calls per user turn.
- 4 planning/replanning cycles per user turn.
- One retry for a transient tool failure.
- No recursive agents or subagents.

### 10.7 Structured model outputs

Where supported, require JSON/structured output for classification and plan updates.

Case classification schema:

```json
{
  "caseType": "invoice_variance",
  "accountId": "abc123",
  "currentPeriod": "2026-08",
  "comparisonPeriod": "2026-07",
  "needsClarification": false,
  "clarificationQuestion": null
}
```

Plan-update schema:

```json
{
  "nextTool": "get_usage_timeseries",
  "reason": "Workers usage explains most of the invoice increase",
  "hypothesisUpdates": [
    {"hypothesis": "H1", "status": "supported"},
    {"hypothesis": "H2", "status": "rejected"}
  ]
}
```

The server must ignore unknown fields and reject unknown tool names.

---

## 11. Tool specifications

All tools are read-only TypeScript functions. They accept validated typed input and return structured JSON. Tools query D1 using prepared statements. No tool accepts raw SQL from the LLM.

Every result includes:

```json
{
  "tool": "tool_name",
  "executedAt": "ISO-8601 timestamp",
  "sourceRecordIds": [],
  "evidence": [],
  "dataLimitations": []
}
```

### 11.1 `get_account_context`

**Purpose:** Validate the account and return high-level metadata and available invoices.

**Input:**

```json
{"accountId": "abc123"}
```

**Output:** account ID, display name, plan type, currency, tax status, available invoice IDs/periods, synthetic flag.

### 11.2 `compare_invoices`

**Purpose:** Compare two finalized invoices and rank their service-level cost drivers.

**Input:**

```json
{
  "accountId": "abc123",
  "currentPeriod": "2026-08",
  "comparisonPeriod": "2026-07"
}
```

**Output:** invoice IDs, totals in cents, absolute and percentage variance, line comparison by service, ranked drivers, explained amount.

### 11.3 `decompose_variance`

**Purpose:** Separate invoice variance into consumption, price, fixed fee, credit, and tax effects.

**Input:** account ID and two periods.

**Output:** effects in cents by service, total effects, unexplained cents, percent explained, price-version IDs used.

### 11.4 `get_usage_timeseries`

**Purpose:** Retrieve daily consumed quantity and contracted cost for one service and period range.

**Input:** account ID, service family/name, start date, end date, optional zone ID.

**Output:** daily data points, totals, unit, zones, source-record IDs.

### 11.5 `get_price_versions`

**Purpose:** Return effective-dated synthetic contract pricing for a service.

**Input:** account ID, service, start date, end date.

**Output:** price versions, included quantity, tier/rate, currency, effective dates, whether a change occurred.

### 11.6 `detect_usage_change_point`

**Purpose:** Identify the most material sustained usage shift in a requested period.

**Input:** account ID, service, start date, end date, optional zone ID.

**Output:** change timestamp/date, baseline daily quantity, post-change daily quantity, ratio, materiality, method, confidence classification.

### 11.7 `get_account_events`

**Purpose:** Retrieve operational and commercial events around a time window.

**Input:** account ID, start timestamp, end timestamp, optional event types.

**Output:** deployments, configuration changes, subscription changes, entitlement changes, and credit events with IDs and timestamps.

### 11.8 `check_duplicate_usage`

**Purpose:** Identify exact and probable duplicate usage records.

**Input:** account ID, service, start date, end date.

**Output:** exact count/quantity/cost, probable count/quantity/cost, fingerprints, sampled record IDs, method.

### 11.9 `reconcile_invoice`

**Purpose:** Reconcile quantities and amounts across raw usage aggregation, rated charges, invoice lines, credits/tax, and final total.

**Input:** account ID and invoice ID or period.

**Output:** checkpoints, expected/actual/difference cents and quantities, pass/fail by boundary, total discrepancy, overall status.

### 11.10 `get_evidence_details`

**Purpose:** Support follow-up questions by retrieving the persisted evidence for one evidence ID.

**Input:** investigation ID and evidence ID.

**Output:** evidence card plus underlying structured tool result. Validate that the evidence belongs to the investigation.

---

## 12. Deterministic computation requirements

### 12.1 Currency

- Store and calculate currency as integer cents.
- Format to USD only at the presentation boundary.
- Never use binary floating-point for money.

### 12.2 Quantities

- Store raw units as integers where possible.
- For pricing quantities expressed in millions, calculate with integer numerator/denominator or a decimal library that works in the Workers runtime.
- Document rounding order.
- For the MVP, round each service’s monthly rated charge to the nearest cent, half up, then sum invoice lines.

### 12.3 Simplified rating

For each service and billing period:

```text
billable_quantity = max(0, consumed_quantity - included_quantity)
usage_charge_cents = rate(billable_quantity, effective_price_version)
```

Support fixed fee plus one linear overage tier for P0. The schema may allow multiple tiers, but multi-tier computation is not required.

### 12.4 Variance

```text
absolute_variance = current_total - comparison_total
percentage_variance = absolute_variance / comparison_total
```

Handle a zero comparison total without division by zero; return percentage as `null` with an explanation.

For potentially nonlinear pricing, use counterfactual computation:

```text
volume_effect = cost(current_quantity, previous_price)
              - cost(previous_quantity, previous_price)

price_effect  = cost(current_quantity, current_price)
              - cost(current_quantity, previous_price)
```

Then calculate fixed-fee, credit, and tax differences independently.

### 12.5 Percent explained

For a nonzero invoice variance:

```text
explained_percent =
  100 * (1 - abs(unexplained_cents) / abs(invoice_variance_cents))
```

Clamp to `[0, 100]`.

### 12.6 Duplicate detection

An exact duplicate has the same `event_id` more than once.

A probable-duplicate fingerprint is a stable hash of:

```text
account_id | service_name | zone_id | source_event_key |
timestamp_bucket | quantity | unit
```

The timestamp bucket for P0 is one minute. If two distinct event IDs share a fingerprint, classify them as probable duplicates. Do not automatically remove them.

### 12.7 Change-point detection

P0 may use a transparent deterministic algorithm:

1. Require at least 14 daily data points.
2. For each candidate day with at least 7 days before and 5 days after, compare pre- and post-window medians.
3. Select the date with the largest sustained absolute percentage change.
4. Mark material if the ratio is at least `1.5x` and the projected cost impact is at least `$100`.
5. Return the algorithm and windows used.

The seed data must produce August 14 as the detected change date.

### 12.8 Event correlation

Return operational events within ±24 hours of the detected change point. Rank by temporal proximity. The evidence status is `correlated`, never `confirmed_cause`.

### 12.9 Reconciliation

Required boundaries:

```text
raw usage sum vs daily aggregated usage
daily aggregated usage vs rated quantity
rated charge vs invoice service line
invoice components vs final invoice total
```

A boundary passes only when:

- Quantity difference equals zero for quantity boundaries.
- Currency difference equals zero cents for financial boundaries.

Do not introduce a tolerance for the golden scenario.

### 12.10 Confidence

Confidence is deterministic:

- **High:** at least 95% of variance explained, reconciliation passes, required checks complete, and no material conflict.
- **Medium:** 70–94.99% explained or one noncritical source is unavailable.
- **Low:** less than 70% explained or material sources conflict.

The LLM may explain the confidence rating but may not change it.

---

## 13. Synthetic data specification

### 13.1 Disclosure

All data is fictional. Product and field terminology may resemble public Cloudflare interfaces, but contract prices and internal pipeline boundaries are illustrative.

### 13.2 Golden account

```text
account_id: abc123
display_name: Acme Corp.
plan_type: Synthetic Enterprise
currency: USD
tax_status: exempt
primary_zone_id: zone-api-acme
primary_zone_name: api.acme.example
```

### 13.3 Billing periods

Seed June, July, and August 2026. P0 investigation compares July and August. June provides historical context for the daily baseline and follow-up questions.

### 13.4 Golden invoice totals

| Service | July 2026 | August 2026 | Variance |
|---|---:|---:|---:|
| Platform fee | $6,000 | $6,000 | $0 |
| Workers | $7,200 | $11,840 | +$4,640 |
| Workers AI | $150 | $330 | +$180 |
| R2 | $2,500 | $2,500 | $0 |
| D1 | $1,050 | $1,050 | $0 |
| **Total** | **$16,900** | **$21,720** | **+$4,820** |

Expected percentage increase:

```text
4820 / 16900 = 28.5207...%, displayed as 28.5%
```

### 13.5 Synthetic contract terms

Workers:

```text
price_version_id: price-workers-2026-01
effective_from: 2026-01-01
effective_to: null
included_quantity: 100,000,000 requests/month
overage_rate: $8 per 1,000,000 requests
```

Workers quantities:

```text
July consumed: 1,000,000,000 requests
July billable: 900,000,000 requests
July cost: $7,200

August consumed: 1,580,000,000 requests
August billable: 1,480,000,000 requests
August cost: $11,840
```

Workers AI:

```text
price_version_id: price-workers-ai-2026-01
effective_from: 2026-01-01
included_quantity: 0
illustrative_rate: $50 per 1,000,000 billable units
July quantity: 3,000,000 -> $150
August quantity: 6,600,000 -> $330
```

R2 and D1 may use fixed synthetic monthly charges for P0. Platform fee is a fixed subscription line.

### 13.6 Daily Workers usage generation

Create deterministic daily usage with a fixed seed. Requirements:

- June and July show a stable weekday/weekend pattern.
- August 1–13 resembles July’s baseline.
- Usage rises materially beginning August 14.
- Most of the increase is attributed to `zone-api-acme`.
- August totals exactly 1,580,000,000 requests.
- July totals exactly 1,000,000,000 requests.
- Adjust the final day’s quantity deterministically if necessary to hit exact totals.
- Preserve realistic positive daily quantities.

Do not store the expected textual conclusion in seed data.

### 13.7 Operational event

```text
event_id: dep-1842
account_id: abc123
event_type: deployment
name: edge-router-v3
zone_id: zone-api-acme
occurred_at: 2026-08-14T09:58:00Z
metadata: synthetic deployment record
```

Usage event timestamps on August 14 must support a detected/aggregated change beginning approximately `2026-08-14T10:20:00Z`. The UI may present a daily change point plus the more precise correlation timestamp where supported by raw data.

### 13.8 Negative facts required by the golden scenario

- No price version changes between July 1 and August 31.
- No subscription or entitlement changes during the comparison window.
- No credits or tax lines in either invoice.
- No duplicate event IDs.
- No probable duplicate fingerprints.
- All reconciliation boundaries pass with zero difference.

### 13.9 Public API-shaped view

Provide a repository/adapter method that returns data shaped similarly to a public billable-usage record:

```json
{
  "BillingCurrency": "USD",
  "BillingPeriodStart": "2026-08-01T00:00:00Z",
  "ChargePeriodStart": "2026-08-14T00:00:00Z",
  "ChargePeriodEnd": "2026-08-14T23:59:59Z",
  "ServiceName": "Workers Standard",
  "ServiceFamilyName": "Workers",
  "ConsumedQuantity": 0,
  "ConsumedUnit": "requests",
  "PricingQuantity": 0,
  "ContractedCost": 0,
  "CumulatedContractedCost": 0,
  "ZoneId": "zone-api-acme",
  "ZoneName": "api.acme.example"
}
```

Populate numeric fields from generated data. This adapter demonstrates a replaceable integration boundary; it must not make live Cloudflare Billing API calls.

---

## 14. Data model

Use migrations and foreign keys where supported. Add indexes for account/period, service/date, invoice lines, and event timestamps.

Required logical tables:

```text
accounts
zones
subscriptions
price_versions
usage_events
daily_usage
rated_charges
invoices
invoice_lines
account_events
```

Suggested investigation tables if state is not entirely agent-local:

```text
investigations
investigation_steps
tool_executions
evidence_items
```

Minimum lineage:

- Each daily usage record references its source usage-event range/count.
- Each rated charge references the price version and aggregated usage record.
- Each invoice line references one or more rated charges or a fixed-fee source.
- Each evidence item references tool execution and source record IDs.

The exact physical schema is an implementation decision. Document it in `ARCHITECTURE.md` and include an entity-relationship diagram.

---

## 15. Application architecture

### 15.1 Required components

```text
React chat/investigation UI
        |
Cloudflare Worker / Agents routing
        |
BillingInvestigatorAgent (Durable Object-backed)
        |-- Workers AI model binding
        |-- allowlisted deterministic tools
        |-- durable conversation/investigation state
        |
D1 synthetic billing database
```

### 15.2 Responsibility boundaries

| Component | Responsibility |
|---|---|
| React UI | Questions, progress, evidence, and final summary |
| Worker routing | HTTP/session routing, validation, safe error mapping |
| Agent | Conversation state, case classification, tool-selection loop, explanation |
| Tool layer | Typed read-only billing operations |
| Domain layer | Rating, variance, duplicates, change point, reconciliation |
| D1 repositories | Prepared queries and persistence |
| Workers AI | Language understanding, bounded planning, final synthesis |

### 15.3 Key architecture rules

- Do not preload three months of raw usage into the LLM prompt.
- Retrieve only the data required by a selected tool.
- Return compact aggregates to the LLM; keep large time series available to the UI as structured evidence.
- Do not expose D1 directly to the model.
- Make tool/domain functions independently testable without Workers AI.
- Keep the model ID configurable through a non-secret environment variable, with Llama 3.3 as the checked-in default.
- Keep synthetic seed generation reproducible.

### 15.4 Optional Workflows usage

P0 does not require Cloudflare Workflows if the Agents SDK/Durable Object reliably coordinates and persists the investigation. If Workflows is added, use it for durable multi-step execution and retries; do not duplicate state ownership ambiguously between the Agent and Workflow. Document the source of truth.

---

## 16. API and interaction contracts

Follow the Agents SDK’s canonical routing for chat/session operations. Add conventional JSON endpoints where useful for deterministic UI data.

Suggested endpoints:

```text
GET  /api/accounts
GET  /api/accounts/:accountId
GET  /api/accounts/:accountId/invoices
POST /api/investigations
GET  /api/investigations/:investigationId
GET  /api/investigations/:investigationId/evidence
POST /api/investigations/:investigationId/reset
```

If the SDK uses RPC or WebSockets instead, preserve equivalent behavior and document it.

All error responses must contain:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe user-facing description",
    "retryable": false,
    "investigationId": "optional"
  }
}
```

Do not return stack traces, prompts, secrets, or raw database errors to the browser.

---

## 17. Security, privacy, and financial controls

Even though this is a synthetic demo:

- Validate and normalize all account IDs, invoice IDs, service names, and dates.
- Use prepared D1 statements.
- Do not allow arbitrary SQL, URLs, file paths, or code execution through tools.
- Apply a strict tool allowlist.
- Ensure tools can only read the account bound to the investigation.
- Treat user content as untrusted; it cannot override the system prompt or tool policy.
- Rate-limit or locally guard runaway message/tool loops.
- Do not include secrets in client bundles, logs, or repository files.
- Never log complete model prompts if they may contain future production data; demo logging may capture redacted metadata.
- Do not implement mutations disguised as recommendations.
- Clearly distinguish “invoice appears correct” from a legally or financially authoritative certification.

---

## 18. Observability

Log structured events for:

- Investigation created/completed/failed
- Case classification
- Tool name, duration, success/failure, and cached/not-cached
- Model invocation duration and token usage when available
- Number of planning cycles
- Percent variance explained
- Reconciliation status
- Final confidence

Use `investigation_id` as the correlation identifier. Do not log private chain-of-thought. Keep logs useful for answering:

- Why did an investigation fail?
- Which tool was slow?
- Did the model exceed the tool-call limit?
- Was the final answer generated from a complete reconciliation?

If AI Gateway is added as P1, document what it observes and how sensitive data would be handled in a production system.

---

## 19. Performance and reliability requirements

- Initial investigation record and visible status: under 1 second under normal demo conditions.
- Each D1-backed deterministic tool: target under 500 ms.
- Complete golden investigation: target under 20 seconds, excluding a clearly communicated transient platform delay.
- UI remains responsive throughout tool execution.
- Transient model/tool failure: retry once where safe.
- On final LLM synthesis failure, display completed evidence and a deterministic fallback summary if completion criteria pass.
- Repeated identical tool calls within one investigation return persisted/cached results.

---

## 20. Testing requirements

### 20.1 Unit tests

Required tests:

- Integer-cent currency behavior.
- Workers July rating equals `$7,200`.
- Workers August rating equals `$11,840`.
- Workers usage variance equals `$4,640`.
- Workers AI variance equals `$180`.
- Invoice variance equals `$4,820`.
- Percentage change displays as `28.5%`.
- Volume/price counterfactual decomposition sums to total variance.
- Price-change result is false for July–August.
- Change-point algorithm selects August 14.
- Duplicate check returns zero exact/probable duplicates.
- Every reconciliation boundary returns zero difference.
- Confidence evaluates to High.
- Zero prior invoice total does not divide by zero.
- Unknown account and invalid date range are rejected.

### 20.2 Tool contract tests

- Each tool validates its input.
- Each tool returns the documented required fields.
- Tools cannot access an account different from the investigation account.
- Unknown tool names are rejected.
- D1 queries are parameterized.
- Identical persisted calls can be reused.

### 20.3 Agent integration tests

Use a mocked/replayable model layer for deterministic CI tests.

- User question is classified as `invoice_variance`.
- Required initial tools are invoked.
- Usage branch is selected after invoice comparison.
- Reconciliation occurs before completion.
- Agent does not declare correctness when reconciliation is missing or failed.
- Agent stops at tool-call limit.
- Agent reports unresolved when evidence conflicts.
- Follow-up question reuses persisted evidence.

### 20.4 Golden end-to-end test

Given:

> Why is account abc123’s August invoice higher than July, and is the bill correct?

Assert that the completed investigation’s structured result contains:

```text
current_total_cents = 2,172,000
comparison_total_cents = 1,690,000
variance_cents = 482,000
workers_variance_cents = 464,000
workers_ai_variance_cents = 18,000
price_changed = false
change_date = 2026-08-14
correlated_event_id = dep-1842
exact_duplicate_count = 0
probable_duplicate_count = 0
reconciliation_status = passed
explained_percent = 100
confidence = high
```

Do not assert exact LLM prose. Assert the structured facts from which prose is produced.

### 20.5 Manual acceptance test

1. Start the project from a clean checkout.
2. Apply migrations and seed data using README commands.
3. Open the application.
4. Run the suggested investigation.
5. Inspect every plan step and evidence card.
6. Refresh the page and confirm state restoration.
7. Ask “Could the usage have been duplicated?”
8. Confirm the answer references the existing duplicate check.
9. Reset the demo and confirm seeded billing data remains unchanged.

---

## 21. Accessibility

- All interactive controls must be keyboard accessible.
- Inputs have associated labels.
- Status changes use text and appropriate ARIA live regions where practical.
- Focus moves predictably after sending a question or opening evidence.
- Charts, if added, include text/table equivalents.
- Do not use color alone to communicate pass/fail or confidence.

---

## 22. Repository and documentation requirements

Suggested structure; adapt to the current Cloudflare starter convention:

```text
/
  src/
    agent/
      BillingInvestigatorAgent.ts
      systemPrompt.ts
      playbooks/
        invoiceVariance.ts
    domain/
      money.ts
      rating.ts
      variance.ts
      changePoint.ts
      duplicates.ts
      reconciliation.ts
    tools/
      definitions.ts
      getAccountContext.ts
      compareInvoices.ts
      decomposeVariance.ts
      getUsageTimeseries.ts
      getPriceVersions.ts
      detectUsageChangePoint.ts
      getAccountEvents.ts
      checkDuplicateUsage.ts
      reconcileInvoice.ts
    repositories/
    ui/
    types/
  migrations/
  seed/
    generateSyntheticData.ts
  test/
    unit/
    integration/
    e2e/
  README.md
  ARCHITECTURE.md
  PROMPT_HISTORY.md
  wrangler.jsonc
```

### README must include

- Product purpose and screenshots/GIF if practical.
- Architecture summary.
- Cloudflare components used and why.
- Local prerequisites.
- Install, migration, seed, test, local run, and deploy commands.
- The golden demo prompt and expected high-level result.
- Synthetic-data disclosure.
- Scope limitations.
- Key design decision: LLM plans/explains; code calculates/reconciles.
- Link to `PROMPT_HISTORY.md`.

### ARCHITECTURE must include

- Component diagram.
- Agent loop.
- Data model/lineage.
- Tool-security boundary.
- State ownership.
- Failure modes.
- Tradeoffs and production evolution.

### PROMPT_HISTORY must include

The application request says AI-assisted coding is encouraged but prompt history must be submitted. Maintain a chronological, human-readable record containing:

- Date/time where practical.
- Coding tool/model.
- User prompt exactly as submitted.
- Concise outcome or files changed.
- Any follow-up/correction prompt.

Do not include credentials, tokens, or hidden system prompts. Begin the file before implementation and update it throughout the build.

---

## 23. Implementation sequence

The coding agent should implement in this order:

### Milestone 1: deterministic domain foundation

- Scaffold current Cloudflare Agents starter.
- Configure Workers AI and D1 bindings.
- Add schema migrations.
- Build reproducible seed generator.
- Implement rating, invoice generation, variance, duplicate detection, change point, and reconciliation.
- Complete all domain unit tests.

**Exit criterion:** Golden calculations pass without any LLM.

### Milestone 2: tool layer

- Implement typed tools and D1 repositories.
- Add evidence/source IDs.
- Add validation and account scoping.
- Complete tool contract tests.

**Exit criterion:** A test can run the entire golden investigation deterministically through tool functions.

### Milestone 3: agent

- Implement system prompt and playbook.
- Add case classification.
- Add bounded tool-selection loop.
- Persist plan, evidence, and completion status.
- Implement structured final summary.
- Add mocked-model integration tests.

**Exit criterion:** Agent cannot declare invoice correctness without reconciliation and cannot call unknown tools.

### Milestone 4: UI

- Build account/suggested-prompt entry.
- Build chat interface.
- Build Plan, Evidence, and Summary tabs.
- Add loading, error, unresolved, refresh, and reset behavior.
- Meet accessibility requirements.

**Exit criterion:** Manual golden flow works and restores after refresh.

### Milestone 5: polish and submission

- Add structured logging.
- Run lint/typecheck/tests/build.
- Deploy to Cloudflare.
- Capture screenshot or short GIF.
- Complete README, architecture document, and prompt history.
- Verify the repository contains no secrets.

**Exit criterion:** A reviewer can understand, run, test, and demo the project from the repository.

---

## 24. Definition of done

P0 is complete only when all are true:

- [ ] Application is deployed and reachable.
- [ ] Cloudflare Workers AI uses Llama 3.3 by default.
- [ ] Agents SDK/Durable Object preserves session state.
- [ ] D1 contains reproducible synthetic data.
- [ ] Suggested prompt launches the complete golden investigation.
- [ ] The agent calls bounded, typed, read-only tools.
- [ ] Financial calculations are deterministic and tested.
- [ ] The $4,820 variance is explained completely and correctly.
- [ ] August 14 and `dep-1842` are identified as correlated.
- [ ] Price is correctly reported as unchanged.
- [ ] Duplicate check returns none.
- [ ] Reconciliation passes at every boundary.
- [ ] The final confidence is High.
- [ ] Evidence is visible for every material claim.
- [ ] Refresh restores the investigation.
- [ ] Follow-up questions use persisted context.
- [ ] No chain-of-thought is shown.
- [ ] Synthetic data is clearly disclosed.
- [ ] Tests, lint, typecheck, and build pass.
- [ ] README, architecture, and prompt history are complete.
- [ ] Repository and client bundle contain no credentials.

---

## 25. Suggested live demo script

Keep the live demonstration under three minutes.

1. **Problem, 20 seconds:** “Billing escalations begin with vague questions and require operators to reconcile multiple stages manually. This agent applies a bounded investigation playbook.”
2. **Submit, 10 seconds:** Run the suggested question for `abc123`.
3. **Plan, 20 seconds:** Point out that the plan is visible and the LLM can only use read-only diagnostic tools.
4. **Evidence, 45 seconds:** Show invoice variance, unchanged price, usage change point, deployment correlation, duplicate check, and reconciliation.
5. **Conclusion, 30 seconds:** Show the evidence-backed answer and recommended action.
6. **Follow-up, 20 seconds:** Ask, “Could the usage have been duplicated?” Demonstrate persisted context.
7. **Architecture, 20 seconds:** Explain: “The LLM handles ambiguity and branching; deterministic TypeScript handles money and correctness; Durable Objects retain the case; D1 stores synthetic billing data.”

---

## 26. Production evolution

Document but do not implement these next steps:

- Replace the synthetic adapter with read-only billing, contract, deployment, and support-system connectors.
- Introduce enterprise RBAC and account-level authorization.
- Encrypt and minimize persisted customer data.
- Add human approval before case creation or financial remediation.
- Add replay/evaluation datasets from resolved investigations.
- Measure investigation time, escalation rate, unsupported-claim rate, and operator acceptance.
- Add playbooks for missing credits, suspected duplicates, pricing disputes, and reconciliation failures.
- Add policy and contract retrieval with source citations.
- Add stronger anomaly detection after sufficient labeled history exists.
- Add evaluation gates before allowing customer-facing explanations.

---

## 27. References

- Cloudflare job application and optional AI assignment: https://job-boards.greenhouse.io/cloudflare/jobs/8152825
- Cloudflare Agents documentation: https://developers.cloudflare.com/agents/
- Workers AI function calling: https://developers.cloudflare.com/workers-ai/features/function-calling/
- Llama 3.3 model documentation: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
- Cloudflare D1 documentation: https://developers.cloudflare.com/d1/
- Cloudflare Durable Objects documentation: https://developers.cloudflare.com/durable-objects/
- Public Billable Usage API concepts and field names: https://blog.cloudflare.com/billable-usage-api/

---

## 28. Final instruction to the coding agent

Build the narrow P0 deeply. The submission should demonstrate that the product can investigate and verify one ambiguous invoice complaint, not merely chat over billing data. Prioritize correctness, evidence, state, testing, and a clean demo over breadth. If time remains, add P1 scenarios only after the golden path is reliable.
