import {
  billingPeriod,
  cents,
  isoDate,
  quantity,
  type BillingPeriod,
  type Cents
} from "../src/domain/units.js";
import type { AccountEvent, PriceVersion } from "../src/domain/types.js";

/**
 * Every figure the seeded scenarios depend on, in one place. PRD §13.
 * All of it is fictional.
 */

/* ------------------------------------------------------------------ *
 * Traffic shape — not account data.
 *
 * These describe the synthetic traffic model itself: the diurnal curve, the
 * weekday/weekend split, the jitter band. They are read-only and identical for
 * every account, so sharing them cannot make one account's output depend on
 * another's. The PRNG is the only thing that must never be shared, and it lives
 * on the profile below.
 * ------------------------------------------------------------------ */

/**
 * Relative daily weights. Only ratios matter: every month is rescaled to its
 * exact target total afterwards.
 */
export const WEEKDAY_WEIGHT = 1000;
export const WEEKEND_WEIGHT = 800;
export const DAY_JITTER = 20;

/** Diurnal shape in UTC: quiet overnight, peak early afternoon. */
export const DIURNAL_WEIGHTS = [
  40, 32, 28, 26, 28, 34, 48, 66, 84, 98, 108, 114, 118, 120, 118, 112, 104, 94,
  84, 74, 64, 56, 50, 44
] as const;

/** Events land at :20 past the hour, so the first shifted one is 10:20Z. */
export const EVENT_MINUTE_UTC = 20;

/* ------------------------------------------------------------------ *
 * Account profiles
 * ------------------------------------------------------------------ */

/** A metered service's identity and the volume it carries, per period. */
export interface MeteredServiceProfile {
  /** Everything but `accountId`, which the generator binds to the profile. */
  price: Omit<PriceVersion, "accountId">;
  /** Prefix for generated event ids, e.g. `ue-workers`. */
  eventIdPrefix: string;
  /** Consumed quantity per billing period, keyed by `YYYY-MM`. */
  quantityByPeriod: Record<string, number>;
}

/**
 * One seeded account, complete.
 *
 * Everything the generator needs comes from here — it reads no account-specific
 * module constant — so two profiles cannot interfere with one another, and the
 * order accounts are generated in cannot change any of their contents.
 *
 * The service catalogue is deliberately fixed at two shapes: one hourly service
 * across both zones, one daily service on the primary zone. Their arithmetic
 * differs (see `workersSlots` vs `workersAiSlots`), so an account with a
 * genuinely different traffic shape wants a *new* shape here, not these two
 * reinterpreted. `docs/BUILD_PLAN_P1.md` §1.3 holds the catalogue constant on
 * purpose: widening it is a change to `InvestigationFacts`, not to seed data.
 */
export interface AccountProfile {
  /**
   * This account's own PRNG stream. Never shared: a second account drawing from
   * the first's stream would make both order-dependent, silently moving a
   * golden fact block that three layers assert.
   */
  seed: number;

  account: {
    accountId: string;
    displayName: string;
    planType: string;
    currency: string;
    taxStatus: string;
    primaryZoneId: string;
    primaryZoneName: string;
  };
  secondaryZone: { zoneId: string; zoneName: string };

  periods: BillingPeriod[];
  /** The pair a demo investigation compares. */
  comparisonPeriod: BillingPeriod;
  currentPeriod: BillingPeriod;

  /** Baseline split across the two zones, as parts of 100. */
  zoneShare: Record<string, number>;

  /** Hourly, both zones. Post-change multiplier is per zone. */
  workers: MeteredServiceProfile & {
    elevationPercentByZone: Record<string, number>;
  };
  /** One slot a day at noon, primary zone only. */
  workersAi: MeteredServiceProfile & { elevationPercent: number };

  subscriptionId: string;
  subscriptionStartedOn: string;
  platformFeeCents: Cents;
  /**
   * Fixed lines with no authorising subscription. Movement in one of these
   * cannot be called explained — see ARCHITECTURE.md §14.
   */
  unauthorisedFixedLines: { serviceName: string; amountCents: Cents }[];

  /** The day consumption steps up, and the hour it starts. PRD §13.6, §13.7. */
  changeDate: string;
  changeHourUtc: number;

  accountEvents: Omit<AccountEvent, "accountId">[];
}

/* ------------------------------------------------------------------ *
 * The golden account — PRD §13. Its fact block must never drift.
 * ------------------------------------------------------------------ */

export const SERVICE_WORKERS = "Workers";
export const SERVICE_WORKERS_AI = "Workers AI";

const ACME_PRIMARY_ZONE = "zone-api-acme";
const ACME_SECONDARY_ZONE = "zone-web-acme";

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

/** The usage shift begins mid-morning on this day. PRD §13.6, §13.7. */
export const CHANGE_DATE = "2026-08-14";

export const COMPARISON_PERIOD = billingPeriod("2026-07");
export const CURRENT_PERIOD = billingPeriod("2026-08");

export const GOLDEN_ACCOUNT: AccountProfile = {
  seed: 20260909,

  account: {
    accountId: "abc123",
    displayName: "Acme Corp.",
    planType: "Synthetic Enterprise",
    currency: "USD",
    taxStatus: "exempt",
    primaryZoneId: ACME_PRIMARY_ZONE,
    primaryZoneName: "api.acme.example"
  },
  secondaryZone: {
    zoneId: ACME_SECONDARY_ZONE,
    zoneName: "www.acme.example"
  },

  periods: ["2026-06", "2026-07", "2026-08"].map((p) => billingPeriod(p)),
  comparisonPeriod: COMPARISON_PERIOD,
  currentPeriod: CURRENT_PERIOD,

  zoneShare: {
    [ACME_PRIMARY_ZONE]: 75,
    [ACME_SECONDARY_ZONE]: 25
  },

  workers: {
    price: WORKERS_PRICE,
    eventIdPrefix: "ue-workers",
    /** July and August are fixed by PRD §13.5. */
    quantityByPeriod: {
      "2026-06": 980_000_000,
      "2026-07": 1_000_000_000,
      "2026-08": 1_580_000_000
    },
    /**
     * Weighted across the zone split these give a whole-account step of ~2.0x,
     * which keeps August 1-13 level with July while sending ~98% of the
     * increase to the primary zone.
     */
    elevationPercentByZone: {
      [ACME_PRIMARY_ZONE]: 228,
      [ACME_SECONDARY_ZONE]: 115
    }
  },

  workersAi: {
    price: WORKERS_AI_PRICE,
    eventIdPrefix: "ue-workersai",
    quantityByPeriod: {
      "2026-06": 2_900_000,
      "2026-07": 3_000_000,
      "2026-08": 6_600_000
    },
    elevationPercent: 307
  },

  subscriptionId: "sub-abc123-enterprise",
  subscriptionStartedOn: "2026-01-01",
  platformFeeCents: cents(600_000), // $6,000
  unauthorisedFixedLines: [
    { serviceName: "R2", amountCents: cents(250_000) }, // $2,500
    { serviceName: "D1", amountCents: cents(105_000) } // $1,050
  ],

  changeDate: CHANGE_DATE,
  changeHourUtc: 10,

  accountEvents: [
    {
      eventId: "dep-1790",
      eventType: "deployment",
      name: "api-gateway-v2",
      zoneId: ACME_PRIMARY_ZONE,
      occurredAt: "2026-07-02T11:15:00Z",
      metadata: "synthetic deployment record"
    },
    {
      eventId: "dep-1842",
      eventType: "deployment",
      name: "edge-router-v3",
      zoneId: ACME_PRIMARY_ZONE,
      occurredAt: "2026-08-14T09:58:00Z",
      metadata: "synthetic deployment record"
    },
    {
      eventId: "cfg-311",
      eventType: "configuration_change",
      name: "cache-rules-update",
      zoneId: ACME_PRIMARY_ZONE,
      occurredAt: "2026-08-14T22:40:00Z",
      metadata: "synthetic configuration record"
    }
  ]
};

/**
 * Every account the seed emits, in emission order.
 *
 * Order affects only the order of rows in the SQL file; it can never affect
 * their contents, because each profile carries its own PRNG seed. The
 * `reverse()` case in `test/unit/seed.spec.ts` is what holds that true.
 */
export const ACCOUNT_PROFILES: readonly AccountProfile[] = [GOLDEN_ACCOUNT];
