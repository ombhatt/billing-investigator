import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialPlan } from "../../src/agent/playbooks/invoiceVariance.js";
import { ALLOWED_TOOLS } from "../../src/tools/registry.js";

const UI_DIR = join(import.meta.dirname, "../../src/ui");
const read = (relative: string) => readFileSync(join(UI_DIR, relative), "utf8");

/**
 * Comments are stripped before scanning: the invariant is about what the panel
 * renders, and the comment explaining the rule necessarily names the identifier
 * the rule is about.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * PRD §7.2: "Display only tool names **translated into** user-friendly
 * actions."
 *
 * The plan panel printed the friendly label and then the raw identifier beside
 * it — `Confirming the account` followed by `get_account_context` — which is
 * the untranslated name the requirement exists to keep off the screen. The
 * label was doing the translating and the `<code>` was undoing it.
 *
 * Evidence cards are the opposite case and must not be caught by this: PRD §8.3
 * lists "Source/tool name" among the six fields each card is required to carry.
 * The rule is about how a *plan step* is named, not a blanket ban.
 */
describe("the plan panel names steps by their action, not their tool", () => {
  const planTab = code(read("tabs/PlanTab.tsx"));

  it("renders no tool identifier", () => {
    // The panel has no legitimate use for the field: steps are keyed by id and
    // labelled by label, so any reference to `.tool` is a rendered one.
    expect(planTab).not.toMatch(/\.tool\b/);
  });

  it("contains no tool name as a literal either", () => {
    for (const tool of ALLOWED_TOOLS) {
      expect(planTab).not.toContain(tool);
    }
  });

  it("still shows the friendly label and the step status", () => {
    // Guards against "fixing" this by rendering nothing at all.
    expect(planTab).toMatch(/\{step\.label\}/);
    expect(planTab).toMatch(/StepStatusBadge/);
  });

  it("gives every playbook step a label that is not its tool name", () => {
    const plan = initialPlan();
    expect(plan.length).toBeGreaterThanOrEqual(9);
    for (const step of plan) {
      expect(step.label).not.toBe(step.tool);
      // No snake_case leaking through a label.
      expect(step.label).not.toMatch(/[a-z]_[a-z]/);
      expect(step.label.trim().length).toBeGreaterThan(3);
    }
  });

  it("keeps the source tool on evidence cards, which PRD §8.3 requires", () => {
    // The complement of the rule above. Removing this would be a regression in
    // the other direction: evidence must be traceable to what produced it.
    expect(read("tabs/EvidenceTab.tsx")).toMatch(/\{card\.source\}/);
  });
});
