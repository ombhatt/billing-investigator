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

