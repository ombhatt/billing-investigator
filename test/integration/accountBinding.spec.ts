import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import {
  DUPLICATE_USAGE_ACCOUNT,
  GOLDEN_ACCOUNT
} from "../../seed/constants.js";
import { seedDataset } from "./seedD1.js";
import { ALLOWED_TOOLS, ToolRunner } from "../../src/tools/registry.js";
import type { ToolDeps } from "../../src/tools/createTool.js";
import { isFailure } from "../../src/types/tools.js";
import { newInvestigation } from "../../src/agent/loop.js";
import { BillingInvestigatorAgent } from "../../src/server.js";
import {
  InMemoryInvestigationStore,
  type InvestigationStore
} from "../../src/agent/investigationStore.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";

const QUESTION =
  "Why is account abc123's August invoice higher than July, and is the bill correct?";

/**
 * The account an investigation is bound to, and the guarantee that a tool
 * cannot read any other one.
 *
 * `INVESTIGATION_ACCOUNT_ID` used to be a module constant, which made rule 5
 * true by construction and therefore untested: there was only ever one account
 * to ask for. Now the account is chosen when an investigation opens, so the
 * guarantee has to be checked rather than assumed.
 * `docs/BUILD_PLAN_P1.md` Milestone 8.
 */

const A = "abc123";
const B = "dup-7741";

/** Arguments that are valid for each tool apart from the account they name. */
const INPUT_FOR: Record<string, (accountId: string) => Record<string, unknown>> = {
  get_account_context: (accountId) => ({ accountId }),
  compare_invoices: (accountId) => ({
    accountId,
    currentPeriod: "2026-08",
    comparisonPeriod: "2026-07"
  }),
  decompose_variance: (accountId) => ({
    accountId,
    currentPeriod: "2026-08",
    comparisonPeriod: "2026-07"
  }),
  get_usage_timeseries: (accountId) => ({
    accountId,
    serviceName: "Workers",
    startDate: "2026-08-01",
    endDate: "2026-08-31"
  }),
  get_price_versions: (accountId) => ({
    accountId,
    serviceName: "Workers",
    startDate: "2026-07-01",
    endDate: "2026-08-31"
  }),
  detect_usage_change_point: (accountId) => ({
    accountId,
    serviceName: "Workers",
    startDate: "2026-08-01",
    endDate: "2026-08-31"
  }),
  get_account_events: (accountId) => ({
    accountId,
    startTimestamp: "2026-08-01T00:00:00Z",
    endTimestamp: "2026-08-31T23:59:59Z"
  }),
  check_duplicate_usage: (accountId) => ({
    accountId,
    serviceName: "Workers",
    startDate: "2026-08-01",
    endDate: "2026-08-31"
  }),
  reconcile_invoice: (accountId) => ({ accountId, period: "2026-08" })
};

beforeAll(async () => {
  await seedDataset(
    env.DB,
    generateSyntheticData(GOLDEN_ACCOUNT),
    generateSyntheticData(DUPLICATE_USAGE_ACCOUNT)
  );
});

describe("a tool may only read the account its investigation is bound to", () => {
  it("covers every tool on the allowlist", () => {
    // A denial suite that silently stopped covering a tool would pass while
    // proving less. Both halves of the matrix below iterate ALLOWED_TOOLS.
    expect(Object.keys(INPUT_FOR).sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  // Both directions: a bug that special-cased the golden account would pass
  // one of these and fail the other.
  for (const [bound, other] of [
    [A, B],
    [B, A]
  ]) {
    describe(`bound to ${bound}`, () => {
      const runner = new ToolRunner({
        db: env.DB,
        investigationAccountId: bound
      } satisfies ToolDeps);

      it(`serves its own account`, async () => {
        for (const tool of ALLOWED_TOOLS) {
          const result = await runner.run(tool, INPUT_FOR[tool](bound) as never);
          expect(isFailure(result), `${tool} failed for its own account`).toBe(
            false
          );
        }
      });

      it(`denies every tool that reaches for ${other}`, async () => {
        for (const tool of ALLOWED_TOOLS) {
          const result = await runner.run(tool, INPUT_FOR[tool](other) as never);
          expect(isFailure(result), `${tool} was not denied`).toBe(true);
          if (isFailure(result)) {
            expect(result.error.code).toBe("ACCOUNT_SCOPE_VIOLATION");
          }
        }
      });

      it(`leaks nothing about ${other} in the denial`, async () => {
        const result = await runner.run(
          "compare_invoices",
          INPUT_FOR.compare_invoices(other) as never
        );
        if (isFailure(result)) {
          // The message names the bound account, never the one asked for, and
          // certainly never a figure from it.
          expect(result.error.message).toContain(bound);
          expect(result.error.message).not.toContain(other);
        }
      });
    });
  }
});

describe("the binding travels with the record, not the request", () => {
  it("opens an investigation on the account it was given", () => {
    const record = newInvestigation("inv-1", B, "Workers");
    expect(record.accountId).toBe(B);
  });

  it("cannot be re-pointed mid-investigation", async () => {
    // The mutation this exists for: a turn that re-read the account from
    // session state instead of the record would follow a switch made while it
    // was still running. The runner is built from the record's account, so
    // asking for the other one is denied rather than served.
    const record = newInvestigation("inv-2", A, "Workers");
    const runner = new ToolRunner({
      db: env.DB,
      investigationAccountId: record.accountId
    } satisfies ToolDeps);

    const own = await runner.run("get_account_context", { accountId: A });
    expect(isFailure(own)).toBe(false);

    const switched = await runner.run("get_account_context", { accountId: B });
    expect(isFailure(switched)).toBe(true);
    if (isFailure(switched)) {
      expect(switched.error.code).toBe("ACCOUNT_SCOPE_VIOLATION");
    }
  });
});

/**
 * The turn reads its account from the record, not from the session.
 *
 * This is the hole Milestone 8 could plausibly open. Tool *arguments* are built
 * from `record.accountId` by `inputFor`, and the runner's `investigationAccountId`
 * is what `createTool` compares them against. If the runner were built from the
 * session's current selection instead of the record's, the two would disagree
 * the moment someone switched account while an investigation was still open —
 * and every tool call in that turn would be denied against its own account.
 *
 * Exercised through the real `onChatMessage`, because that wiring is the thing
 * under test; a directly-constructed `ToolRunner` cannot see it.
 */
class BindingAgent extends BillingInvestigatorAgent {
  memory!: InMemoryInvestigationStore;
  protected override store(): InvestigationStore {
    return this.memory;
  }
}

describe("a live investigation ignores a later account switch", () => {
  it("runs its tools against the account it opened on", async () => {
    const agent = Object.create(BindingAgent.prototype) as BindingAgent;
    const slot = agent as unknown as Record<string, unknown>;
    const memory = new InMemoryInvestigationStore();
    (agent as unknown as { memory: InMemoryInvestigationStore }).memory = memory;

    // An investigation already open on A, mid-flight — not terminal, so the
    // next turn resumes it rather than answering as a follow-up.
    const open = newInvestigation("inv-live", A, "Workers");

    slot.env = { DB: env.DB };
    // Two user messages, so the turn resumes rather than starting fresh.
    slot.messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: QUESTION }] },
      { id: "m2", role: "user", parts: [{ type: "text", text: QUESTION }] }
    ];
    // The session has since been pointed at B. The record still says A.
    Object.defineProperty(agent, "state", {
      configurable: true,
      get: () => ({ accountId: B, investigation: open, generation: 0 })
    });
    slot.modelClient = () => new DeterministicModelClient();
    slot.setState = () => {};

    await (
      slot.onChatMessage as (
        onFinish: unknown,
        options: { requestId: string }
      ) => Promise<Response>
    ).call(agent, undefined, { requestId: "req-binding" });

    const record = memory.state.investigation;
    expect(record).not.toBeNull();
    expect(record!.accountId).toBe(A);

    // The tell: a runner bound to the session's account would have had every
    // call denied against arguments built for the record's account.
    expect(record!.blockers.join(" ")).not.toContain("ACCOUNT_SCOPE_VIOLATION");
    const completed = record!.plan.filter((s) => s.status === "completed");
    expect(completed.length).toBeGreaterThan(0);
    expect(record!.facts.current_total_cents).toBe(2172000);
  });
});
