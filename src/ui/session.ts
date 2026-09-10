/**
 * Which investigation a browser is attached to.
 *
 * The name given to `useAgent` is the Durable Object instance id, so it decides
 * which conversation a visitor joins. A shared constant put every visitor on
 * the planet into the same one: two people reading the deployed demo at once
 * saw each other's questions, and either one's Reset cleared the other's work
 * mid-read.
 *
 * Each browser therefore keeps its own id. The account under investigation is
 * still the single seeded `abc123` — this separates conversations, not tenants,
 * and it is not authentication: the id is an opaque label, it grants nothing,
 * and anyone holding it reads the same read-only synthetic data.
 */

const STORAGE_KEY = "billing-investigator.session";

/**
 * The id is interpolated into the agent's routing path, so only an opaque
 * lowercase slug is ever accepted back out of storage — a stored value
 * containing `/` or `..` would address a different agent instance entirely.
 */
const SAFE_ID = /^s-[0-9a-f-]{36}$/;

export function newSessionName(): string {
  return `s-${crypto.randomUUID()}`;
}

type SessionStore = Pick<Storage, "getItem" | "setItem">;

function browserStore(): SessionStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Blocked by policy in some embedded contexts; reading it can throw.
    return null;
  }
}

/**
 * The browser's investigation id, stable across refreshes.
 *
 * Without usable storage every load starts a fresh conversation. That loses
 * persistence across refresh, which is a demo requirement — but it keeps
 * visitors isolated, and isolation is the property that matters more.
 */
export function resolveSessionName(
  store: SessionStore | null = browserStore()
): string {
  if (!store) return newSessionName();
  try {
    const existing = store.getItem(STORAGE_KEY);
    if (existing && SAFE_ID.test(existing)) return existing;
    const created = newSessionName();
    store.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return newSessionName();
  }
}
