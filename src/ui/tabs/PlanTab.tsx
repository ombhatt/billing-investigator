import type { InvestigationRecord } from "../../agent/types.js";
import { StepStatusBadge } from "../StatusBadge.js";

/**
 * Shows the playbook steps, their status and a one-line factual outcome.
 * The model's reason for choosing a step is never persisted, so there is
 * nothing here that could leak private reasoning. PRD §7.2, §8.2.
 */
export function PlanTab({
  investigation,
  busy
}: {
  investigation: InvestigationRecord | null;
  busy: boolean;
}) {
  if (!investigation) {
    return (
      <p className="panel-empty">
        The investigation plan appears here once you ask a question.
      </p>
    );
  }

  const done = investigation.plan.filter((s) => s.status === "completed").length;

  return (
    <div className="plan">
      <p className="plan__progress" role="status">
        {done} of {investigation.plan.length} steps complete
        {busy ? " · investigating…" : ""}
      </p>

      <ol className="plan__steps">
        {investigation.plan.map((step) => (
          <li key={step.id} className={`plan__step plan__step--${step.status}`}>
            <div className="plan__step-head">
              <span className="plan__step-label">{step.label}</span>
              <StepStatusBadge status={step.status} />
            </div>
            <code className="mono plan__step-tool">{step.tool}</code>
            {step.required && <span className="tag">required</span>}
            {step.outcome && <p className="plan__step-outcome">{step.outcome}</p>}
          </li>
        ))}
      </ol>

      <section className="hypotheses">
        <h3>Hypotheses</h3>
        <ul>
          {investigation.hypotheses.map((h) => (
            <li key={h.id} className={`hypothesis hypothesis--${h.status}`}>
              <code className="mono">{h.id}</code> {h.label}
              <span className="tag">{h.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
