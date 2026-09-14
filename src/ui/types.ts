import type { InvestigationRecord } from "../agent/types.js";

export interface AgentState {
  /** Server-owned. The account the next investigation opens on. */
  accountId: string;
  investigation: InvestigationRecord | null;
  /** Server-owned; advanced by Reset. The UI reads it, never writes it. */
  generation: number;
}

export interface AccountSummary {
  accountId: string;
  displayName: string;
  planType: string;
  currency: string;
  taxStatus: string;
  primaryZoneId: string;
  primaryZoneName: string;
  isSynthetic: boolean;
  zones: { zoneId: string; zoneName: string }[];
  availableInvoices: {
    invoiceId: string;
    period: string;
    status: string;
    totalCents: number;
  }[];
}

export type TabId = "plan" | "evidence" | "summary";
