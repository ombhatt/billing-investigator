import { formatUsd } from "../domain/money.js";
import type { AccountSummary } from "./types.js";

interface Props {
  account: AccountSummary | null;
  error: string | null;
}

export function AccountHeader({ account, error }: Props) {
  if (error) {
    return (
      <section className="account-header account-header--error" role="alert">
        <p>Could not load the account: {error}</p>
      </section>
    );
  }

  if (!account) {
    return (
      <section className="account-header" aria-busy="true">
        <span className="skeleton skeleton--line" aria-hidden="true" />
        <span className="visually-hidden">Loading account…</span>
      </section>
    );
  }

  return (
    <section className="account-header" aria-label="Account under investigation">
      <div className="account-header__identity">
        {/* A single-account P0, so this is a display of the bound account
            rather than a selector. */}
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
