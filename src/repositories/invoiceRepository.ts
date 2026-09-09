import type { Invoice, InvoiceLine, InvoiceLineType } from "../domain/types.js";

interface InvoiceRow {
  invoice_id: string;
  account_id: string;
  period: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  credit_cents: number;
  tax_cents: number;
  total_cents: number;
  issued_on: string;
}

interface InvoiceLineRow {
  line_id: string;
  invoice_id: string;
  account_id: string;
  service_name: string;
  line_type: string;
  quantity: number | null;
  amount_cents: number;
  rated_charge_id: string | null;
  subscription_id: string | null;
}

const INVOICE_COLUMNS = `invoice_id, account_id, period, status, currency,
                         subtotal_cents, credit_cents, tax_cents, total_cents, issued_on`;

function toInvoice(row: InvoiceRow): Invoice {
  return {
    invoiceId: row.invoice_id,
    accountId: row.account_id,
    period: row.period,
    status: row.status,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    creditCents: row.credit_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    issuedOn: row.issued_on
  };
}

export async function listInvoices(
  db: D1Database,
  accountId: string
): Promise<Invoice[]> {
  const { results } = await db
    .prepare(
      `SELECT ${INVOICE_COLUMNS}
         FROM invoices
        WHERE account_id = ?
        ORDER BY period`
    )
    .bind(accountId)
    .all<InvoiceRow>();
  return results.map(toInvoice);
}

export async function findInvoiceByPeriod(
  db: D1Database,
  accountId: string,
  period: string
): Promise<Invoice | null> {
  const row = await db
    .prepare(
      `SELECT ${INVOICE_COLUMNS}
         FROM invoices
        WHERE account_id = ? AND period = ?`
    )
    .bind(accountId, period)
    .first<InvoiceRow>();
  return row ? toInvoice(row) : null;
}

/** Scoped by account as well as invoice so a stray invoice id cannot cross accounts. */
export async function listInvoiceLines(
  db: D1Database,
  accountId: string,
  invoiceId: string
): Promise<InvoiceLine[]> {
  const { results } = await db
    .prepare(
      `SELECT line_id, invoice_id, account_id, service_name, line_type,
              quantity, amount_cents, rated_charge_id, subscription_id
         FROM invoice_lines
        WHERE account_id = ? AND invoice_id = ?
        ORDER BY line_type, service_name`
    )
    .bind(accountId, invoiceId)
    .all<InvoiceLineRow>();

  return results.map((row) => ({
    lineId: row.line_id,
    invoiceId: row.invoice_id,
    accountId: row.account_id,
    serviceName: row.service_name,
    lineType: row.line_type as InvoiceLineType,
    quantity: row.quantity,
    amountCents: row.amount_cents,
    ratedChargeId: row.rated_charge_id,
    subscriptionId: row.subscription_id
  }));
}
