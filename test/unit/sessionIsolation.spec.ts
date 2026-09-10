import { describe, expect, it } from "vitest";
import { newSessionName, resolveSessionName } from "../../src/ui/session.js";
import { mayCommit, nextGeneration } from "../../src/agent/generation.js";

/**
 * Two visitors, one conversation.
 *
 * The name passed to `useAgent` is the Durable Object instance id. Held as a
 * shared constant it meant every browser on the deployed demo joined the same
 * investigation: one reader saw another's questions arrive, and either one's
 * Reset cleared work the other was still reading.
 *
 * The second half of the same defect is temporal rather than cross-visitor.
 * Reset cancels the transport but not the server-side turn, so a turn parked on
 * a model call would resume afterwards and persist its record into the
 * conversation the reader had just cleared.
 */

/** A `localStorage` stand-in; each instance is a separate browser. */
function browser(seed?: string) {
  const cells = new Map<string, string>();
  if (seed !== undefined) cells.set("billing-investigator.session", seed);
  return {
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => void cells.set(k, v)
  };
}

describe("each browser gets its own investigation", () => {
  it("gives two independent browsers different names", () => {
    const a = resolveSessionName(browser());
    const b = resolveSessionName(browser());
    expect(a).not.toBe(b);
  });

  it("keeps one browser's name stable, so a refresh returns to its own work", () => {
    const store = browser();
    const first = resolveSessionName(store);
    expect(resolveSessionName(store)).toBe(first);
    expect(resolveSessionName(store)).toBe(first);
  });

  it("does not hand every browser a shared constant", () => {
    // The exact regression: a fixed name is what made the conversation global.
    const names = new Set(
      Array.from({ length: 25 }, () => resolveSessionName(browser()))
    );
    expect(names.size).toBe(25);
    expect(names.has("demo-abc123")).toBe(false);
  });

  it("still isolates visitors when storage is unavailable", () => {
    // Private browsing loses persistence across refresh, but must not collapse
    // every visitor back into one shared conversation.
    const throwing = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      }
    };
    const a = resolveSessionName(throwing);
    const b = resolveSessionName(throwing);
    expect(a).not.toBe(b);
    expect(resolveSessionName(null)).not.toBe(resolveSessionName(null));
  });
});

describe("a stored name cannot redirect the browser to another agent", () => {
  // The name is interpolated into the agent's routing path, so a tampered
  // storage value must not be able to address a different instance.
  const hostile = [
    "../demo-abc123",
    "s-00000000-0000-0000-0000-000000000000/../other",
    "demo-abc123",
    "s-<script>",
    ""
  ];

  it.each(hostile)("replaces the unsafe value %j", (value) => {
    const store = browser(value);
    const resolved = resolveSessionName(store);
    expect(resolved).not.toBe(value);
    expect(resolved).toMatch(/^s-[0-9a-f-]{36}$/);
  });

  it("accepts a name it issued itself", () => {
    const issued = newSessionName();
    expect(resolveSessionName(browser(issued))).toBe(issued);
  });
});

describe("a turn only commits into the generation it opened in", () => {
  it("commits when nothing interrupted it", () => {
    expect(mayCommit(0, 0)).toBe(true);
    expect(mayCommit(3, 3, new AbortController().signal)).toBe(true);
  });

  it("refuses after a reset moved the generation on", () => {
    expect(mayCommit(0, nextGeneration(0))).toBe(false);
    expect(mayCommit(4, 5)).toBe(false);
  });

  it("refuses when the request was cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    expect(mayCommit(2, 2, controller.signal)).toBe(false);
  });

  it("advances one generation per reset", () => {
    let generation = 0;
    for (let i = 1; i <= 3; i++) {
      generation = nextGeneration(generation);
      expect(generation).toBe(i);
      // Every turn opened before this reset is now locked out.
      for (let opened = 0; opened < i; opened++) {
        expect(mayCommit(opened, generation)).toBe(false);
      }
    }
  });
});
