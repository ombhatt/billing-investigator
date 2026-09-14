import { formatUsd } from "../domain/money.js";
import type { SelectableAccount } from "../agent/accounts.js";
import type { AccountSummary } from "./types.js";

interface Props {
  account: AccountSummary | null;
  error: string | null;
  accounts: readonly SelectableAccount[];
  selected: string;
  busy: boolean;
  onSelect: (accountId: string) => void;
}

/**
 * The picker renders from the static list, not from the fetched account, so it
 * stays usable while an account is loading or has failed to load — which is
 * exactly when someone wants to switch away from it.
 */
function AccountPicker({
  accounts,
  selected,
  busy,
  onSelect
}: Pick<Props, "accounts" | "selected" | "busy" | "onSelect">) {
  if (accounts.length < 2) return null;
  return (
    <div className="account-header__picker">
      <label htmlFor="account-select" className="account-header__label">
        Account
      </label>
      <select
        id="account-select"
        value={selected}
        // Switching is a reset: the server clears the investigation and opens
        // the next one on the chosen account. Disabled mid-turn so a reader
        // cannot start a switch while a turn is still writing.
        disabled={busy}
        onChange={(event) => onSelect(event.target.value)}
      >
        {accounts.map((a) => (
          <option key={a.accountId} value={a.accountId}>
            {a.label} ({a.accountId})
          </option>
        ))}
      </select>
    </div>
  );
}

export function AccountHeader({
  account,
  error,
  accounts,
  selected,
  busy,
  onSelect
}: Props) {
  const picker = (
    <AccountPicker
      accounts={accounts}
      selected={selected}
      busy={busy}
      onSelect={onSelect}
    />
  );

  if (error) {
    return (
      <section className="account-header account-header--error" role="alert">
        <p>Could not load the account: {error}</p>
        {picker}
      </section>
    );
  }

  if (!account) {
    return (
      <section className="account-header" aria-busy="true">
        <span className="skeleton skeleton--line" aria-hidden="true" />
        <span className="visually-hidden">Loading account…</span>
        {picker}
      </section>
    );
  }

  return (
    <section className="account-header" aria-label="Account under investigation">
      {picker}
      <div className="account-header__identity">
        <span className="account-header__name">{account.displayName}</span>
        <code className="mono account-header__id">{account.accountId}</code>
      </div>

      <dl className="account-header__facts">
        <div>
          <dt>Plan</dt>
          <dd>{account.planType}</dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{account.currency}</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>{account.taxStatus}</dd>
        </div>
        <div>
          <dt>Primary zone</dt>
          <dd>
            <code className="mono">{account.primaryZoneName}</code>
          </dd>
        </div>
        <div>
          <dt>Invoices</dt>
          <dd>
            {account.availableInvoices.length > 0
              ? account.availableInvoices
                  .map((i) => `${i.period} (${formatUsd(i.totalCents)})`)
                  .join(" · ")
              : "none"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
