/**
 * Which zone generated the increase — a required follow-up (PRD §7.4).
 *
 * A zone's share of the current period is not its share of the growth, and
 * review found the two being confused. In the seeded August, `api.acme.example`
 * holds 83% of usage but contributed 96% of the additional requests; a zone can
 * also be the largest in the period while contributing nothing at all to the
 * change. Answering the growth question from the period distribution is a
 * guess that happens to land near the right number here and would not elsewhere.
 *
 * Both quantities are therefore computed, named differently, and persisted, so
 * the follow-up is answered from evidence rather than inferred from a share
 * that means something else.
 */

export interface ZoneQuantity {
  zoneId: string;
  quantity: number;
}

export interface ZoneGrowth {
  zoneId: string;
  currentQuantity: number;
  comparisonQuantity: number;
  /** Signed: negative for a zone that shrank. */
  deltaQuantity: number;
  /**
   * Share of the period's net increase. Null when usage did not grow overall,
   * because "share of an increase" is undefined when there was no increase.
   * Can exceed 100 when one zone grew while another shrank — that is the
   * honest reading, not an error.
   */
  shareOfGrowthPercent: number | null;
  /** Share of the current period's usage. A different question entirely. */
  shareOfCurrentPercent: number;
}

function total(zones: ZoneQuantity[]): number {
  return zones.reduce((sum, z) => sum + z.quantity, 0);
}

function byZone(zones: ZoneQuantity[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const zone of zones) {
    map.set(zone.zoneId, (map.get(zone.zoneId) ?? 0) + zone.quantity);
  }
  return map;
}

/**
 * Per-zone movement between two periods, largest contributor to the increase
 * first. Zones present in either period appear: one that vanished shows a
 * negative delta rather than being dropped, since a disappearance explains a
 * decrease.
 */
export function zoneGrowth(
  current: ZoneQuantity[],
  comparison: ZoneQuantity[]
): ZoneGrowth[] {
  const now = byZone(current);
  const before = byZone(comparison);
  const currentTotal = total(current);
  const netGrowth = currentTotal - total(comparison);

  const zoneIds = [...new Set([...now.keys(), ...before.keys()])];

  return zoneIds
    .map((zoneId) => {
      const currentQuantity = now.get(zoneId) ?? 0;
      const comparisonQuantity = before.get(zoneId) ?? 0;
      const deltaQuantity = currentQuantity - comparisonQuantity;
      return {
        zoneId,
        currentQuantity,
        comparisonQuantity,
        deltaQuantity,
        shareOfGrowthPercent:
          netGrowth > 0 ? (deltaQuantity / netGrowth) * 100 : null,
        shareOfCurrentPercent:
          currentTotal > 0 ? (currentQuantity / currentTotal) * 100 : 0
      };
    })
    .sort((a, b) => b.deltaQuantity - a.deltaQuantity || a.zoneId.localeCompare(b.zoneId));
}

/** The zone responsible for most of the increase, when one clearly is. */
export function primaryGrowthZone(growth: ZoneGrowth[]): ZoneGrowth | null {
  const top = growth[0];
  if (!top || top.deltaQuantity <= 0) return null;
  return top;
}
