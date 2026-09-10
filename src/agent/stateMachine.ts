import type { InvestigationState } from "./types.js";

/**
 * PRD §10.3. Transitions are enforced rather than advisory: the loop cannot
 * reach `completed` without passing through `reconciling`, which is what makes
 * "reconciliation before any correctness claim" structural rather than a
 * convention someone can forget.
 */
const TRANSITIONS: Record<InvestigationState, InvestigationState[]> = {
  created: ["clarification_required", "planning", "failed"],
  // Self-transition: a reply that still does not identify two available
  // periods leaves the investigation exactly where it was, waiting. Without it
  // the second unclear answer throws instead of asking again.
  clarification_required: ["clarification_required", "planning", "failed"],
  planning: ["investigating", "failed"],
  investigating: ["reconciling", "failed"],
  reconciling: ["completed", "unresolved", "failed"],
  completed: [],
  unresolved: [],
  // Retry returns to whichever active state was interrupted.
  failed: ["planning", "investigating", "reconciling"]
};

export const ACTIVE_STATES: InvestigationState[] = [
  "created",
  "clarification_required",
  "planning",
  "investigating",
  "reconciling"
];

export function canTransition(
  from: InvestigationState,
  to: InvestigationState
): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransition extends Error {
  constructor(from: InvestigationState, to: InvestigationState) {
    super(`illegal investigation transition: ${from} -> ${to}`);
  }
}

export function transition(
  from: InvestigationState,
  to: InvestigationState
): InvestigationState {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
  return to;
}

export function isTerminal(state: InvestigationState): boolean {
  return state === "completed" || state === "unresolved";
}
