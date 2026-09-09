import { z } from "zod";
import { findAccountById } from "../repositories/accountRepository.js";
import { ok, fail } from "./envelope.js";
import type { ToolResult } from "../types/tools.js";

export const TOOL_NAME = "get_account_context";

/**
 * Account ids are opaque short slugs. Constraining the shape here means a
 * malformed id is rejected before it ever reaches the repository.
 */
export const getAccountContextInput = z.object({
  accountId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "accountId must be 1-64 chars [A-Za-z0-9_-]")
    .describe("The account under investigation, e.g. abc123")
});

export type GetAccountContextInput = z.infer<typeof getAccountContextInput>;

export interface AccountContext {
  accountId: string;
  displayName: string;
  planType: string;
  currency: string;
  taxStatus: string;
  primaryZoneId: string;
  primaryZoneName: string;
  isSynthetic: boolean;
  availableInvoices: { invoiceId: string; period: string }[];
}

export interface ToolDeps {
  db: D1Database;
  /** The tool may only read this account. PRD §17, CLAUDE.md rule 5. */
  investigationAccountId: string;
}

export async function getAccountContext(
  rawInput: unknown,
  deps: ToolDeps
): Promise<ToolResult<AccountContext>> {
  const parsed = getAccountContextInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      TOOL_NAME,
      "INVALID_INPUT",
      parsed.error.issues[0]?.message ?? "Invalid input."
    );
  }

  const { accountId } = parsed.data;

  if (accountId !== deps.investigationAccountId) {
    return fail(
      TOOL_NAME,
      "ACCOUNT_SCOPE_VIOLATION",
      `This investigation is scoped to account ${deps.investigationAccountId}.`
    );
  }

  let row: Awaited<ReturnType<typeof findAccountById>>;
  try {
    row = await findAccountById(deps.db, accountId);
  } catch {
    // Never surface the raw D1 error. PRD §16.
    return fail(
      TOOL_NAME,
      "DATA_SOURCE_UNAVAILABLE",
      "The billing database could not be reached.",
      true
    );
  }

  if (!row) {
    return fail(TOOL_NAME, "ACCOUNT_NOT_FOUND", `No account ${accountId}.`);
  }

  const data: AccountContext = {
    accountId: row.account_id,
    displayName: row.display_name,
    planType: row.plan_type,
    currency: row.currency,
    taxStatus: row.tax_status,
    primaryZoneId: row.primary_zone_id,
    primaryZoneName: row.primary_zone_name,
    isSynthetic: row.is_synthetic === 1,
    // Invoices are seeded in Milestone 2. Reporting an empty list plus a
    // stated limitation is correct; inventing invoice ids would not be.
    availableInvoices: []
  };

  return ok(TOOL_NAME, data, {
    sourceRecordIds: [`accounts:${row.account_id}`],
    evidence: [
      {
        label: "Account under investigation",
        value: `${row.display_name} (${row.account_id}), ${row.plan_type}, ${row.currency}`,
        source: TOOL_NAME,
        recordIds: [`accounts:${row.account_id}`],
        period: null,
        status: "confirmed"
      }
    ],
    dataLimitations: [
      "Invoice history is not yet seeded; available invoices will be populated in Milestone 2."
    ]
  });
}
