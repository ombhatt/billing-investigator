import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { answerFollowUp } from "./agent/followUp.js";
import { mayCommit, nextGeneration } from "./agent/generation.js";
import { newInvestigation, runInvestigationTurn } from "./agent/loop.js";
import { DeterministicModelClient, type ModelClient } from "./agent/modelClient.js";
import { assertServerOwnedState } from "./agent/stateOwnership.js";
import { renderSummary } from "./agent/summary.js";
import { isTerminal } from "./agent/stateMachine.js";
import type { InvestigationRecord } from "./agent/types.js";
import { WorkersAiModelClient } from "./agent/workersAiClient.js";
import { getAccountContext } from "./tools/getAccountContext.js";
import { ToolRunner } from "./tools/registry.js";

/**
 * Milestone 4 still binds one investigation to the single seeded account.
 * Multi-account selection is out of P0 scope.
 */
const INVESTIGATION_ACCOUNT_ID = "abc123";
const FOCUS_SERVICE = "Workers";
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface AgentState {
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
  initialState: AgentState = { investigation: null, generation: 0 };

  /** State persisted before generations existed carries no counter. */
  private currentGeneration(): number {
    return this.state?.generation ?? 0;
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

  /** Server-owned reset: the client asks, it does not write the state itself. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname.split("/").pop() === "reset-investigation"
    ) {
      // Advancing the generation is what makes the reset stick: a turn already
      // parked on a model call can no longer write its record back afterwards.
      this.setState({
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

  /** Audit trail of tool executions. Never contains model reasoning. */
  private recordExecutions(runner: ToolRunner, investigationId: string): void {
    // `void` because these statements are executed for their effect; the
    // tagged template returns rows that a write has no use for.
    void this.sql`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        investigation_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error_code TEXT,
        cached INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        executed_at TEXT NOT NULL
      )`;

    for (const execution of runner.executions) {
      const failed = "error" in execution.result;
      void this.sql`
        INSERT INTO tool_executions
          (investigation_id, tool, input, ok, error_code, cached, duration_ms, executed_at)
        VALUES (
          ${investigationId},
          ${execution.tool},
          ${JSON.stringify(execution.input)},
          ${failed ? 0 : 1},
          ${failed ? (execution.result as { error: { code: string } }).error.code : null},
          ${execution.cached ? 1 : 0},
          ${execution.durationMs},
          ${execution.result.executedAt}
        )`;
    }
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
      const runner = new ToolRunner({
        db: this.env.DB,
        investigationAccountId: INVESTIGATION_ACCOUNT_ID
      });
      const record = await runInvestigationTurn(
        existing ?? newInvestigation(crypto.randomUUID(), INVESTIGATION_ACCOUNT_ID, FOCUS_SERVICE),
        question,
        { runner, model, focusService: FOCUS_SERVICE }
      );

      // The tool calls genuinely ran, so the audit trail keeps them either way.
      // It is the investigation record that must not come back from the dead.
      this.recordExecutions(runner, record.investigationId);
      if (!stillOurs()) return this.discardedTurn();
      // Writing `openedIn` rather than re-reading: a turn never advances the
      // generation, it only ever commits into the one it was started in.
      this.setState({ investigation: record, generation: openedIn });

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

    // Account header data, needed before any investigation has run.
    const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountMatch) {
      const result = await getAccountContext(
        { accountId: decodeURIComponent(accountMatch[1]) },
        { db: env.DB, investigationAccountId: INVESTIGATION_ACCOUNT_ID }
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
