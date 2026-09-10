import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import { BillingInvestigatorAgent } from "../../src/server.js";
import type {
  CaseClassification,
  ClassifyInput,
  ExplainInput,
  ModelClient,
  PlanInput,
  PlanUpdate
} from "../../src/agent/modelClient.js";

const dataset = generateSyntheticData();
const QUESTION =
  "Why is account abc123's August invoice higher than July, and is the bill correct?";

/**
 * Reset has to end an investigation, not just hide it.
 *
 * `clearHistory()` cancels the turn at the transport, but the server-side turn
 * is an ordinary awaited promise chain: when the model call it was parked on
 * finally resolved, it carried on and persisted its record — restoring, in full,
 * the investigation the reader had just cleared.
 */

/** A model that parks inside `classify` until the test releases it. */
class GatedModel implements ModelClient {
  private release!: () => void;
  readonly opened: Promise<void>;
  private announceOpened!: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    this.opened = new Promise((resolve) => {
      this.announceOpened = resolve;
    });
  }

  /** Let the parked turn run to completion. */
  finish(): void {
    this.release();
  }

  async classify(input: ClassifyInput): Promise<CaseClassification> {
    this.announceOpened();
    await this.gate;
    return {
      caseType: "invoice_variance",
      accountId: input.boundAccountId,
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07",
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  async planNext(input: PlanInput): Promise<PlanUpdate> {
    return {
      nextTools: input.availableTools.map((t) => t.tool),
      reason: "run the remaining diagnostics",
      hypothesisUpdates: [],
      done: false
    };
  }

  async explain(_input: ExplainInput): Promise<string> {
    return "August is higher than July because metered Workers usage rose.";
  }
}

/**
 * The real `onChatMessage` and `onRequest`, run against a stand-in for the
 * Durable Object's persistence. Everything under test — the generation read,
 * the commit guard, the ordering between them — is the shipped code.
 */
function harness(model: ModelClient) {
  const agent = Object.create(
    BillingInvestigatorAgent.prototype
  ) as BillingInvestigatorAgent;

  // The Durable Object's own members are protected, so the stand-ins are
  // installed as own properties that shadow the prototype at runtime.
  const slot = agent as unknown as Record<string, unknown>;

  let state: { investigation: unknown; generation: number } = {
    investigation: null,
    generation: 0
  };

  Object.defineProperty(agent, "state", { get: () => state });
  slot.setState = (next: typeof state) => {
    state = next;
  };
  slot.env = { DB: env.DB };
  slot.messages = [
    { id: "m1", role: "user", parts: [{ type: "text", text: QUESTION }] }
  ];
  // The audit trail writes to the DO's own SQL, which is not what is under test.
  slot.sql = () => [];
  // Shadows the private accessor so no Workers AI binding is needed.
  slot.modelClient = () => model;

  const ask = (options?: { abortSignal?: AbortSignal }) =>
    (
      slot.onChatMessage as (
        onFinish: unknown,
        options: { requestId: string; abortSignal?: AbortSignal }
      ) => Promise<Response>
    ).call(agent, undefined, { requestId: "req-1", ...options });

  const reset = () =>
    agent.onRequest(
      new Request("http://do/agents/x/y/reset-investigation", { method: "POST" })
    );

  return { agent, ask, reset, read: () => state };
}

describe("a turn interrupted by Reset cannot write itself back", () => {
  beforeEach(async () => {
    await seedDataset(env.DB, dataset);
  });

  it("discards the record when the model returns after a reset", async () => {
    const model = new GatedModel();
    const { ask, reset, read } = harness(model);

    // A turn is in flight, parked on the model.
    const turn = ask();
    await model.opened;
    expect(read().investigation).toBeNull();

    // The reader presses Reset while it is still running.
    expect((await reset()).status).toBe(204);
    expect(read().generation).toBe(1);

    // The model call finally returns and the turn runs to completion.
    model.finish();
    await turn;

    // Nothing came back from the dead.
    expect(read().investigation).toBeNull();
    expect(read().generation).toBe(1);
  });

  it("discards the record when the request was cancelled", async () => {
    const model = new GatedModel();
    const { ask, read } = harness(model);
    const controller = new AbortController();

    const turn = ask({ abortSignal: controller.signal });
    await model.opened;
    controller.abort();
    model.finish();
    await turn;

    expect(read().investigation).toBeNull();
  });

  it("commits normally when nothing interrupted it", async () => {
    // Without this the two tests above would pass on a turn that never
    // completed, and would keep passing with the guard removed.
    const model = new GatedModel();
    const { ask, read } = harness(model);

    const turn = ask();
    await model.opened;
    model.finish();
    await turn;

    const committed = read().investigation as { state: string } | null;
    expect(committed).not.toBeNull();
    expect(committed?.state).toBe("completed");
    expect(read().generation).toBe(0);
  });

  it("lets the next question start cleanly after a reset", async () => {
    const model = new GatedModel();
    const { agent, ask, reset, read } = harness(model);

    const interrupted = ask();
    await model.opened;
    await reset();
    model.finish();
    await interrupted;
    expect(read().investigation).toBeNull();

    // A fresh turn opened after the reset commits into the new generation.
    const second = new GatedModel();
    (agent as unknown as Record<string, unknown>).modelClient = () => second;
    const turn = ask();
    await second.opened;
    second.finish();
    await turn;

    expect(read().investigation).not.toBeNull();
    expect(read().generation).toBe(1);
  });
});

/** Opens a real agent WebSocket and collects what the server sends back. */
async function connect(instance: string) {
  const response = await SELF.fetch(
    `http://example.com/agents/billing-investigator-agent/${instance}`,
    { headers: { Upgrade: "websocket" } }
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("agent did not upgrade the connection");

  const received: Record<string, unknown>[] = [];
  socket.addEventListener("message", (event) => {
    try {
      received.push(JSON.parse(String(event.data)));
    } catch {
      /* non-JSON frames are irrelevant here */
    }
  });
  socket.accept();
  return { socket, received };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const resetOf = (instance: string) =>
  SELF.fetch(
    `http://example.com/agents/billing-investigator-agent/${instance}/reset-investigation`,
    { method: "POST" }
  );

const generations = (frames: Record<string, unknown>[]) =>
  frames
    .filter((m) => m.type === "cf_agent_state")
    .map((m) => (m.state as { generation?: number } | undefined)?.generation);

/**
 * Two visitors over real Durable Objects. Reset is the observable side effect:
 * it advances the generation and the SDK broadcasts the new state to everyone
 * attached to that instance.
 */
describe("visitors on different session names are isolated", () => {
  it("does not deliver one visitor's reset to another", async () => {
    const alice = await connect(`iso-a-${crypto.randomUUID()}`);
    const bobInstance = `iso-b-${crypto.randomUUID()}`;
    const bob = await connect(bobInstance);
    await settle();
    alice.received.length = 0;
    bob.received.length = 0;

    await resetOf(bobInstance);
    await settle();

    // Bob's own conversation moved on; Alice's was untouched.
    expect(generations(bob.received)).toContain(1);
    expect(generations(alice.received).filter((g) => g === 1)).toHaveLength(0);

    for (const c of [alice, bob]) c.socket.close();
  });

  it("shows why a shared name was the defect", async () => {
    // Both browsers on one instance: the reset reaches the visitor who did not
    // ask for it. This is precisely what a per-browser name prevents.
    const shared = `iso-shared-${crypto.randomUUID()}`;
    const first = await connect(shared);
    const second = await connect(shared);
    await settle();
    second.received.length = 0;

    await resetOf(shared);
    await settle();

    expect(generations(second.received)).toContain(1);

    for (const c of [first, second]) c.socket.close();
  });
});
