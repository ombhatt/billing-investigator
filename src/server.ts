import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { answerFollowUp } from "./agent/followUp.js";
import { newInvestigation, runInvestigationTurn } from "./agent/loop.js";
import { DeterministicModelClient, type ModelClient } from "./agent/modelClient.js";
import { renderSummary } from "./agent/summary.js";
import { isTerminal } from "./agent/stateMachine.js";
import type { InvestigationRecord } from "./agent/types.js";
import { WorkersAiModelClient } from "./agent/workersAiClient.js";
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
}

export class BillingInvestigatorAgent extends AIChatAgent<Env, AgentState> {
  maxPersistedMessages = 100;
  // `as const` keeps the literal type; a widened `boolean` is not assignable.
  chatRecovery = true as const;

  // Synced to the UI and persisted by the Durable Object, which is what
  // restores plan, evidence and summary after a refresh. Bulk tool payloads are
  // written to this.sql instead so state stays small.
  initialState: AgentState = { investigation: null };

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

  async onChatMessage(_onFinish: unknown, _options?: OnChatMessageOptions) {
    const last = this.messages.at(-1);
    const question =
      last?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("") ?? "";

    const model = this.modelClient();
    const existing = this.state.investigation;

    let text: string;
    let toolActivity: { tool: string; label: string; outcome: string | null }[] = [];

    if (existing && isTerminal(existing.state)) {
      // Follow-up: answered from persisted evidence, no new tool calls.
      const followUp = await answerFollowUp(existing, question, model);
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

      this.recordExecutions(runner, record.investigationId);
      this.setState({ investigation: record });

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

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
