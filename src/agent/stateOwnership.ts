/**
 * The investigation record is authoritative: it carries the figures, the
 * completion verdict and the confidence rating that the whole product's
 * credibility rests on.
 *
 * The Agents SDK accepts `cf_agent_state` messages from any connected client
 * and, by default, persists and broadcasts them without validation. Left
 * unguarded, a browser could post a fabricated `completed` investigation with
 * invented totals and `invoiceAppearsCorrect: true`, have it broadcast to every
 * other viewer, and have follow-ups treat it as evidence.
 *
 * State therefore only ever moves server-side. Clients read it; they do not
 * write it.
 */
export class ClientStateWriteRejected extends Error {
  constructor() {
    super(
      "Investigation state is server-owned and cannot be set by a client."
    );
    this.name = "ClientStateWriteRejected";
  }
}

/** `source` is "server" for server-initiated writes, or the client connection. */
export function assertServerOwnedState(source: unknown): void {
  if (source !== "server") throw new ClientStateWriteRejected();
}
