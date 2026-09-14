import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { answerFollowUp } from "./agent/followUp.js";
import { mayCommit, nextGeneration } from "./agent/generation.js";
import {
  DurableObjectStore,
  type InvestigationStore
} from "./agent/investigationStore.js";
import { newInvestigation, runInvestigationTurn } from "./agent/loop.js";
import { DeterministicModelClient, type ModelClient } from "./agent/modelClient.js";
import {
  DEFAULT_ACCOUNT_ID,
  focusServiceFor,
  isSelectableAccount,
  selectAccountId
} from "./agent/accounts.js";
import { assertServerOwnedState } from "./agent/stateOwnership.js";
import { renderSummary } from "./agent/summary.js";
import { isTerminal } from "./agent/stateMachine.js";
import type { InvestigationRecord } from "./agent/types.js";
import { WorkersAiModelClient } from "./agent/workersAiClient.js";
import { getAccountContext } from "./tools/getAccountContext.js";
import { ToolRunner } from "./tools/registry.js";

const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface AgentState {
  /**
   * The account this session opens investigations on. Server-owned like the
   * rest of this state: a client asks for it through `reset-investigation`, and
   * only `selectAccountId` decides what is actually stored.
   *
   * This is what the *next* investigation will bind. A running investigation
   * carries its own `accountId` on the record and is never re-read from here,
   * so changing the selection cannot redirect a turn already in flight.
   */
  accountId: string;
  investigation: InvestigationRecord | null;
  /**
   * Advanced by every reset. A turn may only commit into the generation it
   * opened in, so work started before a reset cannot write itself back
   * afterwards. Server-owned, like the record.
   */
  generation: number;
}

export class BillingInvestigatorAgent extends AIChatAgent<Env, AgentState> {
  maxPersistedMessages = 100;
  // `as const` keeps the literal type; a widened `boolean` is not assignable.
  chatRecovery = true as const;

  // Synced to the UI and persisted by the Durable Object, which is what
  // restores plan, evidence and summary after a refresh. Bulk tool payloads are
  // written to this.sql instead so state stays small.
  initialState: AgentState = {
    accountId: DEFAULT_ACCOUNT_ID,
    investigation: null,
    generation: 0
  };

  /** State persisted before generations existed carries no counter. */
  private currentGeneration(): number {
    return this.state?.generation ?? 0;
  }

  /** State persisted before accounts were selectable carries no account. */
  private currentAccountId(): string {
    return this.state?.accountId ?? DEFAULT_ACCOUNT_ID;
  }

  /**
   * The SDK's default accepts client-sent state, persists it and broadcasts it
   * to every other connection. Investigation facts, the completion verdict and
   * the confidence rating are all server-computed, so a client write is always
   * either a forgery attempt or a bug. Reject both.
   */
  validateStateChange(_nextState: AgentState, source: unknown): void {
    assertServerOwnedState(source);
  }

  /**
   * Server-owned reset: the client asks, it does not write the state itself.
   *
   * Choosing an account is the same operation, deliberately. An investigation
   * cannot change the account it is bound to partway through, so offering the
   * two separately would invite exactly that; folding them together makes
   * "switching account starts a new investigation" structural rather than a
   * rule someone has to remember.
   *
   * The account arrives as a query parameter rather than a JSON body so this
   * handler stays synchronous up to `setState`. Awaiting a body here would put
   * a yield point between reading the generation and writing it, which is the
   * one thing the reset path must not have.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname.split("/").pop() === "reset-investigation"
    ) {
      // Client input, treated as such: `selectAccountId` is the only thing that
      // decides what is stored, so an unrecognised name never reaches a record.
      const requested = url.searchParams.get("account");

      // Advancing the generation is what makes the reset stick: a turn already
      // parked on a model call can no longer write its record back afterwards.
      this.setState({
        accountId: selectAccountId(requested, this.currentAccountId()),
        investigation: null,
        generation: nextGeneration(this.currentGeneration())
      });
      return new Response(null, { status: 204 });
    }
    return super.onRequest(request);
  }

  private modelClient(): ModelClient {
    try {
      const workersai = createWorkersAI({ binding: this.env.AI });
      const modelId = this.env.MODEL_ID || DEFAULT_MODEL_ID;
      return new WorkersAiModelClient(
        workersai(modelId as Parameters<typeof workersai>[0], {
          sessionAffinity: this.sessionAffinity
        })
      );
    } catch {
      return new DeterministicModelClient();
    }
  }

  /**
   * Where evidence and state are kept.
   *
   * A seam rather than inline SQL: the agent no longer owns a table schema, and
   * a test can substitute an in-memory implementation instead of shadowing the
   * Durable Object's own storage.
   */
  protected store(): InvestigationStore {
    return new DurableObjectStore({
      sql: (strings, ...values) =>
        this.sql(strings, ...(values as (string | number | boolean | null)[])) as never,
      readGeneration: () => this.currentGeneration(),
      setState: (investigation, generation) =>
        this.setState({
          accountId: this.currentAccountId(),
          investigation,
          generation
        })
    });
  }

  /**
   * A turn that was reset or cancelled while it was running answers nobody.
   *
   * The client has already discarded the exchange, so the stream is empty; the
   * point is that nothing is persisted. Read immediately before `setState` with
   * no `await` between them, so the check and the write cannot be interleaved.
   */
  private discardedTurn(): Response {
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          const id = "response";
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-end", id });
        }
      })
    });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const store = this.store();
    const openedIn = this.currentGeneration();
    const abortSignal = options?.abortSignal;
    const stillOurs = () =>
      mayCommit(openedIn, this.currentGeneration(), abortSignal);

    const last = this.messages.at(-1);
    const question =
      last?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("") ?? "";

    const model = this.modelClient();

    // `clearHistory()` deletes the chat messages but not this agent's state, so
    // a Reset would otherwise leave a completed investigation behind and every
    // later question would be treated as a follow-up to it. The first user
    // message of a conversation always starts a fresh investigation.
    const isNewConversation =
      this.messages.filter((m) => m.role === "user").length <= 1;
    const existing = isNewConversation ? null : this.state.investigation;

    let text: string;
    let toolActivity: { tool: string; label: string; outcome: string | null }[] = [];

    if (existing && isTerminal(existing.state)) {
      // Follow-up: answered from persisted evidence, no new tool calls.
      const followUp = await answerFollowUp(existing, question, model);
      if (!stillOurs()) return this.discardedTurn();
      text = followUp.text;
    } else {
      // The account is bound once, when the investigation opens, and every
      // later read comes from the record. A resumed investigation keeps the
      // account it opened on even if the session's selection has since moved.
      const opened =
        existing ??
        newInvestigation(
          crypto.randomUUID(),
          this.currentAccountId(),
          focusServiceFor(this.currentAccountId())
        );
      // `opened.accountId`, never `this.state.accountId`: this is the value
      // `createTool` compares every call against, so reading it from anywhere
      // but the bound record would be the hole rule 5 exists to close.
      const runner = new ToolRunner(
        { db: this.env.DB, investigationAccountId: opened.accountId },
        { store, investigationId: opened.investigationId }
      );
      const record = await runInvestigationTurn(opened, question, {
        runner,
        model,
        focusService: opened.focusService
      });

      // The tool calls genuinely ran, so their envelopes are kept either way —
      // evidence and limitations included, which is what makes them reusable.
      // It is the investigation record that must not come back from the dead.
      await store.record(record.investigationId, runner.executions);
      if (abortSignal?.aborted) return this.discardedTurn();
      // The store checks the generation and writes without an await between,
      // so a reset cannot land in the gap.
      if (!(await store.commit(record, openedIn))) return this.discardedTurn();

      toolActivity = record.plan
        .filter((s) => s.status === "completed")
        .map((s) => ({ tool: s.tool, label: s.label, outcome: s.outcome }));

      text =
        record.state === "clarification_required"
          ? (record.clarificationQuestion ?? "Which periods should I compare?")
          : record.summary
            ? renderSummary(record.summary)
            : "The investigation could not be completed.";
    }

    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        // Friendly action names only. Model reasoning is never emitted. PRD §8.2.
        for (const step of toolActivity) {
          writer.write({
            type: "tool-input-available",
            toolCallId: `${step.tool}-${crypto.randomUUID()}`,
            toolName: step.label,
            input: {}
          });
        }
        const id = "response";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}

/** PRD §16 error shape. Never carries a stack trace or a raw database error. */
function errorResponse(
  code: string,
  message: string,
  status: number
): Response {
  return Response.json(
    { error: { code, message, retryable: status >= 500 } },
    { status }
  );
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Account header data, needed before any investigation has run, so it
    // cannot be scoped to a bound investigation. Scoped to the selectable list
    // instead: this route reads public synthetic context for an account the
    // *server* offers, and never on behalf of a running investigation.
    const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch) {
      const accountId = decodeURIComponent(accountMatch[1]);
      if (!isSelectableAccount(accountId)) {
        return errorResponse(
          "ACCOUNT_NOT_FOUND",
          "No such account.",
          404
        );
      }
      const result = await getAccountContext(
        { accountId },
        { db: env.DB, investigationAccountId: accountId }
      );
      if ("error" in result) {
        const status =
          result.error.code === "ACCOUNT_NOT_FOUND" ||
          result.error.code === "ACCOUNT_SCOPE_VIOLATION"
            ? 404
            : 400;
        return errorResponse(result.error.code, result.error.message, status);
      }
      return Response.json(result.data);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      errorResponse("NOT_FOUND", "No such route.", 404)
    );
  }
} satisfies ExportedHandler<Env>;
