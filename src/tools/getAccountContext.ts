import { z } from "zod";
import { findAccountById, listZones } from "../repositories/accountRepository.js";
import { listInvoices } from "../repositories/invoiceRepository.js";
import { createTool, NotFound } from "./createTool.js";
import { accountIdSchema } from "./validators.js";

export const TOOL_NAME = "get_account_context";

export const inputSchema = z.object({
  accountId: accountIdSchema.describe("The account under investigation")
});

export const getAccountContext = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId }, { db }) => {
    const account = await findAccountById(db, accountId);
    if (!account) {
      throw new NotFound("ACCOUNT_NOT_FOUND", `No account ${accountId}.`);
    }

    const [zones, invoices] = await Promise.all([
      listZones(db, accountId),
      listInvoices(db, accountId)
    ]);

    return {
      data: {
        ...account,
        zones: zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName })),
        availableInvoices: invoices.map((i) => ({
          invoiceId: i.invoiceId,
          period: i.period,
          status: i.status,
          totalCents: i.totalCents
        }))
      },
      sourceRecordIds: [
        `accounts:${account.accountId}`,
        ...invoices.map((i) => `invoices:${i.invoiceId}`)
      ],
      evidence: [
        {
          label: "Account under investigation",
          value: `${account.displayName} (${account.accountId}), ${account.planType}, ${account.currency}`,
          source: TOOL_NAME,
          recordIds: [`accounts:${account.accountId}`],
          period: null,
          status: "confirmed" as const
        },
        {
          label: "Invoices available",
          value:
            invoices.length > 0
              ? invoices.map((i) => i.period).join(", ")
              : "none",
          source: TOOL_NAME,
          recordIds: invoices.map((i) => `invoices:${i.invoiceId}`),
          period: null,
          status: invoices.length > 0 ? ("confirmed" as const) : ("not_found" as const)
        }
      ],
      dataLimitations: account.isSynthetic
        ? ["All figures for this account are synthetic."]
        : []
    };
  }
);
