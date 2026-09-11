import {
  billingPeriod,
  cents,
  isoDate,
  quantity
} from "../src/domain/units.js";

/**
 * Every figure the golden scenario depends on, in one place. PRD §13.
 * All of it is fictional.
 */

export const SEED = 20260909;

export const ACCOUNT = {
  accountId: "abc123",
  displayName: "Acme Corp.",
  planType: "Synthetic Enterprise",
  currency: "USD",
  taxStatus: "exempt",
  primaryZoneId: "zone-api-acme",
  primaryZoneName: "api.acme.example"
} as const;

export const SECONDARY_ZONE = {
  zoneId: "zone-web-acme",
  zoneName: "www.acme.example"
} as const;

export const PERIODS = ["2026-06", "2026-07", "2026-08"].map((p) =>
  billingPeriod(p)
);
export const COMPARISON_PERIOD = billingPeriod("2026-07");
export const CURRENT_PERIOD = billingPeriod("2026-08");

export const SERVICE_WORKERS = "Workers";
export const SERVICE_WORKERS_AI = "Workers AI";

/** Monthly consumed quantities. July and August are fixed by PRD §13.5. */
export const WORKERS_QUANTITY: Record<string, number> = {
  "2026-06": 980_000_000,
  "2026-07": 1_000_000_000,
  "2026-08": 1_580_000_000
};

export const WORKERS_AI_QUANTITY: Record<string, number> = {
  "2026-06": 2_900_000,
  "2026-07": 3_000_000,
  "2026-08": 6_600_000
};

/** Fixed monthly lines, in cents. PRD §13.4. */
export const PLATFORM_FEE_CENTS = cents(600_000); // $6,000
export const R2_CENTS = cents(250_000); // $2,500
export const D1_CENTS = cents(105_000); // $1,050

export const SUBSCRIPTION_ID = "sub-abc123-enterprise";

/** The usage shift begins mid-morning on this day. PRD §13.6, §13.7. */
export const CHANGE_DATE = "2026-08-14";
export const CHANGE_HOUR_UTC = 10;
/** Events land at :20 past the hour, so the first shifted one is 10:20Z. */
export const EVENT_MINUTE_UTC = 20;

export const DEPLOYMENT_EVENT = {
  eventId: "dep-1842",
  name: "edge-router-v3",
  zoneId: ACCOUNT.primaryZoneId,
  occurredAt: "2026-08-14T09:58:00Z"
} as const;

/**
 * Relative daily weights. Only ratios matter: every month is rescaled to its
 * exact target total afterwards.
 */
export const WEEKDAY_WEIGHT = 1000;
export const WEEKEND_WEIGHT = 800;
export const DAY_JITTER = 20;

/** Baseline split between the two zones, as parts of 100. */
export const ZONE_SHARE = {
  [ACCOUNT.primaryZoneId]: 75,
  [SECONDARY_ZONE.zoneId]: 25
} as const;

/**
 * Post-change multipliers as integer percent. Weighted across the zone split
 * these give a whole-account step of ~2.0x, which keeps August 1-13 level with
 * July while sending ~98% of the increase to the primary zone.
 */
export const ZONE_ELEVATION_PERCENT = {
  [ACCOUNT.primaryZoneId]: 228,
  [SECONDARY_ZONE.zoneId]: 115
} as const;

export const WORKERS_AI_ELEVATION_PERCENT = 307;

/** Diurnal shape in UTC: quiet overnight, peak early afternoon. */
export const DIURNAL_WEIGHTS = [
  40, 32, 28, 26, 28, 34, 48, 66, 84, 98, 108, 114, 118, 120, 118, 112, 104, 94,
  84, 74, 64, 56, 50, 44
] as const;

export const WORKERS_PRICE = {
  priceVersionId: "price-workers-2026-01",
  serviceName: SERVICE_WORKERS,
  serviceFamily: "Workers",
  includedQuantity: quantity(100_000_000),
  overageRateCents: cents(800), // $8.00
  unitDivisor: 1_000_000, // per million requests
  unit: "requests",
  fixedFeeCents: cents(0),
  effectiveFrom: isoDate("2026-01-01"),
  effectiveTo: null
} as const;

export const WORKERS_AI_PRICE = {
  priceVersionId: "price-workers-ai-2026-01",
  serviceName: SERVICE_WORKERS_AI,
  serviceFamily: "Workers AI",
  includedQuantity: quantity(0),
  overageRateCents: cents(5000), // $50.00
  unitDivisor: 1_000_000, // per million billable units
  unit: "units",
  fixedFeeCents: cents(0),
  effectiveFrom: isoDate("2026-01-01"),
  effectiveTo: null
} as const;
