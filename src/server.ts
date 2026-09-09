import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { SYSTEM_PROMPT } from "./agent/systemPrompt.js";
import { buildTools } from "./tools/definitions.js";

/**
 * Milestone 1 pins the investigation to the single seeded golden account.
 * Milestone 4 replaces this with the account bound to the investigation record.
 */
const INVESTIGATION_ACCOUNT_ID = "abc123";

const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * The model's context window is 24,000 tokens and its max_tokens default is
 * 256, which would truncate a final answer. Both are set explicitly.
 */
const MAX_OUTPUT_TOKENS = 1024;

/** One tool call plus a synthesis step covers M1. PRD §10.6 raises this in M4. */
const MAX_STEPS = 5;

export class BillingInvestigatorAgent extends AIChatAgent<Env> {
  // Durable Object-backed message persistence; this is what survives refresh.
  maxPersistedMessages = 100;
  // `as const` keeps the literal type; a widened `boolean` is not assignable.
  chatRecovery = true as const;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const modelId = this.env.MODEL_ID || DEFAULT_MODEL_ID;

    // `generateText`, not `streamText`: under workers-ai-provider 3.3.1 with
    // ai 6.x, streamed tool-call argument deltas are appended rather than
    // replaced, so arguments arrive doubled and interleaved
    // (`{"accountId": "{"accountId": "abcabc123"}123"}`). That fails JSON
    // parsing, the tool never executes, and the model retries until it hits the
    // step limit. Non-streaming generation produces correct arguments.
    // Upgrading the provider is not yet possible: v4 requires ai ^7, while
    // @cloudflare/ai-chat pins ai 6.
    const result = await generateText({
      model: workersai(modelId as Parameters<typeof workersai>[0], {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools: buildTools({
        db: this.env.DB,
        investigationAccountId: INVESTIGATION_ACCOUNT_ID
      }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal
    });

    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        for (const step of result.steps) {
          for (const call of step.toolCalls) {
            writer.write({
              type: "tool-input-available",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input
            });
          }
          for (const toolResult of step.toolResults) {
            writer.write({
              type: "tool-output-available",
              toolCallId: toolResult.toolCallId,
              output: toolResult.output
            });
          }
        }

        const textId = "response";
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: result.text });
        writer.write({ type: "text-end", id: textId });
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
