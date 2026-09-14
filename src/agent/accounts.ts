/**
 * Which accounts a client may open an investigation on.
 *
 * The same shape as the tool allowlist, and for the same reason: a name chosen
 * by a client arrives as a plain string, and this is the single place one
 * becomes an account the server will act on. Anything else is rejected before
 * it can reach the record, so the id that ends up bound is always one the
 * server named — never one the client invented.
 *
 * This is **selection, not authorisation**. P0 and P1 have no auth by design
 * (PRD §4.2), and every account here holds synthetic data that any visitor may
 * read. What rule 5 actually guarantees is narrower and is enforced elsewhere:
 * within one investigation, a tool may read only the account that investigation
 * is bound to. `createTool` is the backstop for that, and it compares against
 * the record, not against this list.
 *
 * Kept in `src/` rather than imported from `seed/` because what exists in the
 * database and what a deployment offers are different questions. They happen to
 * agree today, and `test/unit/accounts.spec.ts` fails if they ever drift.
 */

export interface SelectableAccount {
  accountId: string;
  /**
   * Where an investigation starts looking before the decomposition has run.
   *
   * Only ever a placeholder: `pickFocusService` replaces it with the largest
   * absolute mover as soon as `decompose_variance` reports, so this is the
   * value used for nothing more than the first moments of a turn. It lives per
   * account rather than as one global constant so that an account without a
   * `Workers` line cannot inherit a service it does not have.
   */
  focusService: string;
}

export const SELECTABLE_ACCOUNTS: readonly SelectableAccount[] = [
  { accountId: "abc123", focusService: "Workers" },
  { accountId: "dup-7741", focusService: "Workers" }
];

/** The account a session opens on before anyone chooses otherwise. */
export const DEFAULT_ACCOUNT_ID = SELECTABLE_ACCOUNTS[0].accountId;

/**
 * The narrowing boundary for a client-supplied account name.
 *
 * Mirrors `isAllowedTool`: past this point the value is one of ours.
 */
export function isSelectableAccount(accountId: string): boolean {
  return SELECTABLE_ACCOUNTS.some((a) => a.accountId === accountId);
}

/**
 * The starting focus service for an account, or the default account's.
 *
 * Never throws: an unknown id cannot reach here through `selectAccountId`, and
 * a stale id persisted before an account was withdrawn should degrade to a
 * usable investigation rather than break the session.
 */
export function focusServiceFor(accountId: string): string {
  return (
    SELECTABLE_ACCOUNTS.find((a) => a.accountId === accountId)?.focusService ??
    SELECTABLE_ACCOUNTS[0].focusService
  );
}

/**
 * Resolve a requested account to one the server will act on.
 *
 * An absent request keeps what the session already had; an unrecognised one
 * falls back to the default rather than failing the request, because the only
 * thing a bad id can cost here is the choice itself — it can never widen what a
 * bound investigation may read.
 */
export function selectAccountId(
  requested: unknown,
  current: string = DEFAULT_ACCOUNT_ID
): string {
  if (typeof requested !== "string" || requested.length === 0) return current;
  return isSelectableAccount(requested) ? requested : DEFAULT_ACCOUNT_ID;
}
