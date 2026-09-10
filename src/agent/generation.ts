/**
 * Reset has to be able to *end* an investigation, not merely hide it.
 *
 * `clearHistory()` cancels the active turn in the SDK, but cancellation only
 * stops the transport: the server-side turn is an ordinary awaited promise
 * chain, and when the model call it was parked on finally resolves it carries
 * on to persist its record. The reader who pressed Reset then watches the
 * cleared investigation reappear — with its plan, evidence and verdict — as
 * though nothing had happened.
 *
 * So the conversation carries a generation counter. Every reset advances it. A
 * turn captures the generation it opened in and may only commit into that same
 * generation; a turn that opened before a reset finds the number has moved and
 * discards its work. The counter is server-owned, like the record itself, and
 * `validateStateChange` refuses client writes to it.
 */

/** The generation a reset moves the conversation into. */
export function nextGeneration(current: number): number {
  return current + 1;
}

/**
 * Whether a turn that opened in `openedIn` may still write its result.
 *
 * Two ways to lose the right: the reader reset the conversation (the generation
 * moved), or the request was cancelled outright (the SDK aborts the active turn
 * on clear, and `useAgentChat` aborts on unmount). Either one means the answer
 * is for a conversation that no longer exists.
 */
export function mayCommit(
  openedIn: number,
  current: number,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted) return false;
  return current === openedIn;
}
