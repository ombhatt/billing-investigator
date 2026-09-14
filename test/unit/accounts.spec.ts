import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  SELECTABLE_ACCOUNTS,
  focusServiceFor,
  isSelectableAccount,
  selectAccountId
} from "../../src/agent/accounts.js";
import { ACCOUNT_PROFILES } from "../../seed/constants.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";

/**
 * Which accounts a client may open an investigation on.
 *
 * Selection, not authorisation — every account here is synthetic and readable.
 * What matters is that a *client-supplied* name can only ever become one of
 * ours, because whatever is stored here is what `createTool` will compare every
 * subsequent tool call against.
 */
describe("account selection", () => {
  it("offers exactly the accounts the seed builds", () => {
    // The two lists answer different questions — what exists, and what a
    // deployment offers — and are allowed to differ in principle. They do not
    // today, and this fails the moment one moves without the other.
    expect(SELECTABLE_ACCOUNTS.map((a) => a.accountId).sort()).toEqual(
      ACCOUNT_PROFILES.map((p) => p.account.accountId).sort()
    );
  });

  it("names a focus service each account actually bills", () => {
    for (const profile of ACCOUNT_PROFILES) {
      const dataset = generateSyntheticData(profile);
      const services = new Set(dataset.invoiceLines.map((l) => l.serviceName));
      expect(services.has(focusServiceFor(profile.account.accountId))).toBe(true);
    }
  });

  it("rejects a name that is not on the list", () => {
    expect(isSelectableAccount("abc123")).toBe(true);
    for (const forged of [
      "xyz789",
      "",
      "abc123 ",
      "ABC123",
      "abc123' OR '1'='1",
      "../abc123"
    ]) {
      expect(isSelectableAccount(forged)).toBe(false);
    }
  });

  it("keeps the current account when nothing is asked for", () => {
    expect(selectAccountId(undefined, "dup-7741")).toBe("dup-7741");
    expect(selectAccountId(null, "dup-7741")).toBe("dup-7741");
    expect(selectAccountId("", "dup-7741")).toBe("dup-7741");
  });

  it("never yields a name it was not given from the list", () => {
    for (const forged of [
      "xyz789",
      "../abc123",
      { accountId: "dup-7741" },
      ["dup-7741"],
      42
    ]) {
      const chosen = selectAccountId(forged, "abc123");
      expect(isSelectableAccount(chosen)).toBe(true);
    }
  });

  it("switches to a listed account when one is asked for", () => {
    expect(selectAccountId("dup-7741", "abc123")).toBe("dup-7741");
    expect(selectAccountId("abc123", "dup-7741")).toBe("abc123");
  });

  it("defaults to the golden account", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("abc123");
  });
});
