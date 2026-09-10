import type { Hypothesis, PlanStep } from "../types.js";

/**
 * The fixed invoice-variance playbook. PRD §10.2: the application owns the
 * required steps, the model only chooses among conditional ones.
 */

/** Run first, in this order. The model cannot remove or reorder these. */
export const REQUIRED_PRELUDE = [
  { tool: "get_account_context", label: "Confirming the account" },
  { tool: "compare_invoices", label: "Comparing invoices" },
  {
    tool: "decompose_variance",
    label: "Separating usage, price, credit and tax effects"
  }
] as const;

/** Always runs last, forced by the server before any completion check. */
export const REQUIRED_RECONCILIATION = {
  tool: "reconcile_invoice",
  label: "Reconciling usage with the invoice"
} as const;

/** The model may select from these, and only these. */
export const CONDITIONAL_STEPS = [
  {
    tool: "get_usage_timeseries",
    label: "Inspecting daily usage",
    when: "consumption changed materially and its shape over time is unknown"
  },
  {
    tool: "get_price_versions",
    label: "Checking contract pricing",
    when: "price must be ruled in or out as a driver"
  },
  {
    tool: "detect_usage_change_point",
    label: "Locating the usage change",
    when: "consumption changed and the date it started is unknown"
  },
  {
    tool: "get_account_events",
    label: "Checking account events near the change",
    when: "a change point was found and nearby operational events are unknown"
  },
  {
    tool: "check_duplicate_usage",
    label: "Checking for duplicate usage",
    when: "usage rose and duplication has not been ruled out"
  }
] as const;

export const CONDITIONAL_TOOLS: readonly string[] = CONDITIONAL_STEPS.map(
  (s) => s.tool
);

export const REQUIRED_TOOLS: readonly string[] = [
  ...REQUIRED_PRELUDE.map((s) => s.tool),
  REQUIRED_RECONCILIATION.tool
];

export function isConditionalTool(tool: string): boolean {
  return CONDITIONAL_TOOLS.includes(tool);
}

/** PRD §10.6 limits, enforced server-side. */
export const MAX_TOOL_CALLS_PER_TURN = 12;
export const MAX_PLANNING_CYCLES_PER_TURN = 4;
export const MAX_TOOL_RETRIES = 1;

export function initialPlan(): PlanStep[] {
  const step = (
    tool: string,
    label: string,
    required: boolean
  ): PlanStep => ({
    id: tool,
    tool,
    label,
    required,
    status: "pending",
    outcome: null
  });

  return [
    ...REQUIRED_PRELUDE.map((s) => step(s.tool, s.label, true)),
    ...CONDITIONAL_STEPS.map((s) => step(s.tool, s.label, false)),
    step(REQUIRED_RECONCILIATION.tool, REQUIRED_RECONCILIATION.label, true)
  ];
}

/** PRD §10.4. */
export function initialHypotheses(): Hypothesis[] {
  return [
    { id: "H1", label: "Consumption changed", status: "untested" },
    { id: "H2", label: "Effective price changed", status: "untested" },
    { id: "H3", label: "Subscription or entitlement changed", status: "untested" },
    { id: "H4", label: "Credit or tax treatment changed", status: "untested" },
    { id: "H5", label: "Usage was duplicated or omitted", status: "untested" },
    {
      id: "H6",
      label: "Rating or invoice generation introduced a discrepancy",
      status: "untested"
    }
  ];
}
