import { tool } from "ai";
import type { ToolDeps } from "./createTool.js";
import {
  getAccountContext,
  inputSchema as accountContextInput,
  TOOL_NAME as GET_ACCOUNT_CONTEXT
} from "./getAccountContext.js";

export { ALLOWED_TOOLS, isAllowedTool, ToolRunner } from "./registry.js";

/**
 * Tools exposed to the model.
 *
 * Milestone 3 built all nine tools and their allowlist in `registry.ts`, but
 * deliberately keeps the model's surface at one: without the bounded loop and
 * playbook that Milestone 4 adds, handing this model nine tools invites the
 * retry loop already seen in M1. The registry is the seam M4 opens up.
 */
export function buildTools(deps: ToolDeps) {
  return {
    [GET_ACCOUNT_CONTEXT]: tool({
      description:
        "Look up the account being investigated: display name, plan type, " +
        "currency, tax status, zones, and available invoices. " +
        "Call this before answering any question about which account is in scope.",
      inputSchema: accountContextInput,
      execute: async (input) => await getAccountContext(input, deps)
    })
  };
}
