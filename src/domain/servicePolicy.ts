/**
 * Which services get checked, and which one gets investigated in depth.
 *
 * This is a *policy*, not a calculation, and it was being decided in three
 * places. The agent loop learned to run pricing and duplicate checks once per
 * metered service (an invoice-wide claim needs an invoice-wide check), while
 * the deterministic runner and the pure-domain case still checked only the
 * focus service. The golden fixture agreed either way — nothing is repriced in
 * it — so the divergence was invisible until a non-driver service moved.
 *
 * Keeping the policy here lets the domain analysis stay an independent
 * implementation of the *arithmetic*, which is what makes the cross-path
 * equality check worth having, without it also being an independent opinion
 * about which services to look at.
 */

export interface ServiceCandidate {
  serviceName: string;
  /** Null for fixed-fee lines, which have no usage pipeline to check. */
  currentQuantity: number | null;
  totalEffectCents: number;
}

/**
 * Services with a usage pipeline behind them, sorted for stable ordering.
 *
 * A fixed monthly fee has no usage to reprice or duplicate, so a price or
 * duplicate check against it is meaningless rather than merely empty.
 */
export function meteredServiceNames(services: ServiceCandidate[]): string[] {
  return services
    .filter((s) => s.currentQuantity !== null)
    .map((s) => s.serviceName)
    .sort();
}

/**
 * The service worth investigating in depth: the largest absolute mover.
 *
 * Absolute, so a large fall is as interesting as a large rise. A compile-time
 * constant is right only by luck, and was: the seeded driver happens to be
 * Workers.
 */
export function driverService(
  services: ServiceCandidate[],
  fallback: string
): string {
  const ranked = services
    .filter((s) => s.currentQuantity !== null)
    .sort((a, b) => Math.abs(b.totalEffectCents) - Math.abs(a.totalEffectCents));
  return ranked[0]?.serviceName ?? fallback;
}
