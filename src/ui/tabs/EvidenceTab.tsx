import type { InvestigationRecord } from "../../agent/types.js";
import { EvidenceStatusBadge } from "../StatusBadge.js";

/**
 * Each card carries the six fields PRD §8.3 requires: label, value, source
 * tool, record IDs, period, and status.
 */
export function EvidenceTab({
  investigation
}: {
  investigation: InvestigationRecord | null;
}) {
  if (!investigation || investigation.evidence.length === 0) {
    return (
      <p className="panel-empty">
        Evidence gathered during the investigation appears here, each item naming
        the tool and records it came from.
      </p>
    );
  }

  return (
    <ul className="evidence">
      {investigation.evidence.map((card, index) => (
        <li key={`${card.source}-${card.label}-${index}`} className="evidence-card">
          <div className="evidence-card__head">
            <h3 className="evidence-card__label">{card.label}</h3>
            <EvidenceStatusBadge status={card.status} />
          </div>

          <p className="evidence-card__value">{card.value}</p>

          <dl className="evidence-card__meta">
            <div>
              <dt>Source</dt>
              <dd>
                <code className="mono">{card.source}</code>
              </dd>
            </div>
            {card.period && (
              <div>
                <dt>Period</dt>
                <dd>
                  <code className="mono">{card.period}</code>
                </dd>
              </div>
            )}
            {card.recordIds.length > 0 && (
              <div>
                <dt>Records</dt>
                <dd className="evidence-card__records">
                  {/* Long record lists are truncated for legibility; the count
                      still tells the reader how much was drawn on. */}
                  {card.recordIds.slice(0, 4).map((id) => (
                    <code className="mono" key={id}>
                      {id}
                    </code>
                  ))}
                  {card.recordIds.length > 4 && (
                    <span className="evidence-card__more">
                      +{card.recordIds.length - 4} more
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ul>
  );
}
