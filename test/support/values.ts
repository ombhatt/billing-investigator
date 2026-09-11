/**
 * Short constructors for test fixtures.
 *
 * Tests build the same validated values the production code does, rather than
 * casting past the constructors. That means a fixture with a fractional cent or
 * an impossible date fails in the test that wrote it — which is where the
 * mistake is — instead of surfacing as a confusing assertion further down.
 */
export {
  billingPeriod as per,
  cents as c,
  isoDate as day,
  quantity as q
} from "../../src/domain/units.js";
