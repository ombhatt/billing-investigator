import { periodEnd, periodStart } from "../domain/period.js";
import type { BillingPeriod } from "../domain/units.js";
import type { ToolInput, ToolName } from "../tools/catalog.js";

import type { InvestigationRecord } from "./types.js";

/**
 * Tool arguments, built by the server from the investigation record.
 *
 * The model never supplies an argument. It chooses *which* conditional tools
 * run, within the allowlist; every value those tools receive is derived here
 * from state the server computed. That is what keeps PRD §10.7 true without the
 * loop having to validate model-supplied arguments at all.
 *
 * One builder per tool, each returning that tool's exact input type, so a
 * misspelled or mistyped argument fails the build rather than the request. A
 * builder returns null when the record cannot supply the arguments yet, which
 * the caller reports as a skipped step rather than a failed one.
 */
type InputBuilder<N extends ToolName> = (
  record: InvestigationRecord,
  service: string | undefined
) => ToolInput<N> | null;

/**
 * Both periods, or null. Returning them rather than a boolean is what lets the
 * builders below drop their non-null assertions.
 */
function periods(
  record: InvestigationRecord
): { current: BillingPeriod; comparison: BillingPeriod } | null {
  return record.currentPeriod && record.comparisonPeriod
    ? { current: record.currentPeriod, comparison: record.comparisonPeriod }
    : null;
}

const INPUT_BUILDERS: { [N in ToolName]: InputBuilder<N> } = {
  get_account_context: (record) => ({ accountId: record.accountId }),

  compare_invoices: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        currentPeriod: p.current,
        comparisonPeriod: p.comparison
      }
    );
  },

  decompose_variance: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        currentPeriod: p.current,
        comparisonPeriod: p.comparison
      }
    );
  },

  // Scoped to the driver: where and when consumption moved. The comparison
  // window is requested too, because the required "which zone generated the
  // increase?" follow-up answers from persisted evidence and needs a baseline
  // to compare against. ARCHITECTURE.md §19.
  get_usage_timeseries: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: record.focusService,
        startDate: periodStart(p.current),
        endDate: periodEnd(p.current),
        comparisonStartDate: periodStart(p.comparison),
        comparisonEndDate: periodEnd(p.comparison)
      }
    );
  },

  detect_usage_change_point: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: record.focusService,
        startDate: periodStart(p.current),
        endDate: periodEnd(p.current)
      }
    );
  },

  // Run per metered service, since the conclusion is invoice-wide.
  check_duplicate_usage: (record, service) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: service ?? record.focusService,
        startDate: periodStart(p.current),
        endDate: periodEnd(p.current)
      }
    );
  },

  get_price_versions: (record, service) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: service ?? record.focusService,
        startDate: periodStart(p.comparison),
        endDate: periodEnd(p.current)
      }
    );
  },

  get_account_events: (record) => {
    // Only meaningful once a change point exists to anchor the window.
    if (!periods(record) || !record.facts.change_date) return null;
    const anchor = Date.parse(`${record.facts.change_date}T00:00:00Z`);
    return {
      accountId: record.accountId,
      startTimestamp: new Date(anchor - 86_400_000).toISOString(),
      endTimestamp: new Date(anchor + 86_400_000).toISOString()
    };
  },

  reconcile_invoice: (record) => {
    const p = periods(record);
    return p && { accountId: record.accountId, period: p.current };
  }
};

/**
 * The arguments for one tool call, or null when the record cannot supply them.
 *
 * The cast is the one place the per-tool types are rejoined: indexing a mapped
 * type with a generic `N` gives TypeScript no way to see that the builder it
 * found is the builder for `N`. Every builder above is checked against its own
 * tool's input type at the point it is written, which is where the guarantee
 * actually comes from.
 */
export function inputFor<N extends ToolName>(
  tool: N,
  record: InvestigationRecord,
  service?: string
): ToolInput<N> | null {
  return (INPUT_BUILDERS[tool] as InputBuilder<N>)(record, service) || null;
}
