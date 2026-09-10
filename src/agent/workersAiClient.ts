import { generateText, type LanguageModel } from "ai";
import { formatUsd } from "../domain/money.js";
import {
  classificationSchema,
  planUpdateSchema,
  type CaseClassification,
  type ClassifyInput,
  type ExplainInput,
  type ModelClient,
  type PlanInput,
  type PlanUpdate
} from "./modelClient.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_JSON_TOKENS = 400;
const MAX_PROSE_TOKENS = 700;

/**
 * Pulls the first JSON object out of a model response. `response_format` is
 * undocumented for this model, so the prompt asks for JSON and this recovers it
 * from any surrounding prose rather than trusting the shape.
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Workers AI implementation. `generateText`, not `streamText`: under
 * workers-ai-provider 3.x with ai 6.x the streamed path corrupts structured
 * output the same way it corrupts tool-call arguments (see BUILD_STATUS).
 */
export class WorkersAiModelClient implements ModelClient {
  constructor(private readonly model: LanguageModel) {}

  private async json<T>(
    prompt: string,
    parse: (value: unknown) => T
  ): Promise<T> {
    // One repair attempt before giving up; the caller falls back deterministically.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text } = await generateText({
        model: this.model,
        system: SYSTEM_PROMPT,
        prompt:
          attempt === 0
            ? prompt
            : `${prompt}\n\nYour previous reply was not valid JSON. Reply with the JSON object only, no prose.`,
        maxOutputTokens: MAX_JSON_TOKENS
      });
      try {
        return parse(extractJson(text));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("unparseable model output");
  }

  async classify(input: ClassifyInput): Promise<CaseClassification> {
    return await this.json(
      [
        "Classify this billing question.",
        `Question: ${input.question}`,
        `Account under investigation: ${input.boundAccountId}`,
        `Billing periods available: ${input.availablePeriods.join(", ")}`,
        "",
        "Reply with only this JSON:",
        '{"caseType":"invoice_variance","accountId":"<account>","currentPeriod":"YYYY-MM",' +
          '"comparisonPeriod":"YYYY-MM","needsClarification":false,"clarificationQuestion":null}',
        "",
        "Pick the most recent period as currentPeriod and the one before it as comparisonPeriod,",
        "unless the question names specific periods. Set needsClarification only if the question",
        "is not about an invoice changing between two periods."
      ].join("\n"),
      (value) => classificationSchema.parse(value)
    );
  }

  async planNext(input: PlanInput): Promise<PlanUpdate> {
    return await this.json(
      [
        "Choose which diagnostic checks to run next.",
        `Question: ${input.question}`,
        "",
        "What is known so far:",
        JSON.stringify(input.facts),
        "",
        "Checks still available:",
        ...input.availableTools.map((t) => `- ${t.tool}: use when ${t.when}`),
        "",
        `You may select at most ${input.remainingToolBudget} of them.`,
        "",
        "Reply with only this JSON:",
        '{"nextTools":["<tool>"],"reason":"<short>","hypothesisUpdates":[{"hypothesis":"H1","status":"supported"}],"done":false}',
        "",
        "Hypotheses: H1 consumption changed, H2 price changed, H3 subscription changed,",
        "H4 credit or tax changed, H5 usage duplicated or omitted, H6 rating or invoicing discrepancy.",
        "Set done to true only when no further check would add evidence."
      ].join("\n"),
      (value) => planUpdateSchema.parse(value)
    );
  }

  async explain(input: ExplainInput): Promise<string> {
    const facts = input.facts;
    const closing =
      input.mode === "summary"
        ? [
            "Write ONLY the finding: two or three sentences of plain prose saying what",
            "changed and why. The evidence list, the assessment and the recommended next",
            "step are generated deterministically and appended after your text, so do not",
            "write them, and do not use headings or bullet points."
          ]
        : [
            "Answer the question above directly and only that question, in two or three",
            "sentences. Lead with the answer, then cite the figure or finding that supports",
            "it. Do not re-summarise the whole investigation, and do not use headings.",
            "If the evidence does not cover the question, say so plainly."
          ];

    const { text } = await generateText({
      model: this.model,
      system: SYSTEM_PROMPT,
      prompt: [
        input.mode === "summary"
          ? "Write the answer for a billing operations colleague."
          : "A billing operations colleague has a follow-up question about a completed investigation.",
        `Question: ${input.question}`,
        "",
        "Verified figures (use these exactly; do not recalculate):",
        `- previous invoice total: ${formatUsd(facts.comparison_total_cents ?? 0)}`,
        `- current invoice total: ${formatUsd(facts.current_total_cents ?? 0)}`,
        `- change: ${formatUsd(facts.variance_cents ?? 0)}${
          facts.percentage_variance_display === null
            ? ""
            : ` (${facts.percentage_variance_display}%)`
        }`,
        `- Workers movement: ${formatUsd(facts.workers_variance_cents ?? 0)}`,
        `- Workers AI movement: ${formatUsd(facts.workers_ai_variance_cents ?? 0)}`,
        `- price changed: ${facts.price_changed}`,
        `- usage change date: ${facts.change_date ?? "none found"}`,
        `- nearest operational event: ${facts.correlated_event_id ?? "none"}`,
        `- duplicates: ${facts.exact_duplicate_count ?? "?"} exact, ${facts.probable_duplicate_count ?? "?"} probable`,
        `- reconciliation: ${facts.reconciliation_status ?? "not run"}`,
        `- variance explained: ${facts.explained_percent ?? "?"}%`,
        `- confidence: ${facts.confidence ?? "?"}`,
        // A follow-up may ask about something the fact block does not carry --
        // which zone grew, for instance -- so the evidence cards come too.
        ...(input.mode === "follow_up"
          ? [
              "",
              "Evidence gathered during the investigation:",
              ...input.evidence.map((card) => `- ${card.label}: ${card.value}`)
            ]
          : []),
        "",
        input.invoiceAppearsCorrect
          ? "The checks passed, so you may say the invoice appears correct."
          : `The investigation is unresolved. Outstanding: ${input.blockers.join("; ")}. Do not say the invoice is correct.`,
        "",
        ...closing,
        "",
        "Rules: use only the figures above. Describe any event near the usage change as",
        "correlated in time, never as the cause. Do not invent records."
      ].join("\n"),
      maxOutputTokens: MAX_PROSE_TOKENS
    });
    return text;
  }
}
