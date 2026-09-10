import { useId, useRef } from "react";
import type { InvestigationRecord } from "../agent/types.js";
import type { TabId } from "./types.js";
import { PlanTab } from "./tabs/PlanTab.js";
import { EvidenceTab } from "./tabs/EvidenceTab.js";
import { SummaryTab } from "./tabs/SummaryTab.js";

const TABS: { id: TabId; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "evidence", label: "Evidence" },
  { id: "summary", label: "Summary" }
];

interface Props {
  investigation: InvestigationRecord | null;
  active: TabId;
  onSelect: (tab: TabId) => void;
  busy: boolean;
}

export function InvestigationPanel({
  investigation,
  active,
  onSelect,
  busy
}: Props) {
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const counts: Record<TabId, number | null> = {
    plan: investigation
      ? investigation.plan.filter((s) => s.status === "completed").length
      : null,
    evidence: investigation ? investigation.evidence.length : null,
    summary: null
  };

  // Arrow-key navigation is what the tablist pattern expects; without it a
  // keyboard user has to tab through every panel to reach the next tab.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === active);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next];
    onSelect(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <aside className="investigation" aria-label="Investigation details">
      <div className="tablist" role="tablist" aria-label="Investigation details">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            id={`${baseId}-tab-${tab.id}`}
            type="button"
            role="tab"
            className={`tab ${active === tab.id ? "tab--active" : ""}`}
            aria-selected={active === tab.id}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
            {counts[tab.id] !== null && counts[tab.id]! > 0 && (
              <span className="tab__count">{counts[tab.id]}</span>
            )}
          </button>
        ))}
      </div>

      <div
        id={`${baseId}-panel-${active}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${active}`}
        tabIndex={0}
        className="tabpanel"
      >
        {active === "plan" && (
          <PlanTab investigation={investigation} busy={busy} />
        )}
        {active === "evidence" && <EvidenceTab investigation={investigation} />}
        {active === "summary" && <SummaryTab investigation={investigation} />}
      </div>
    </aside>
  );
}
