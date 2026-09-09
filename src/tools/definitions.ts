import { tool } from "ai";
import {
  TOOL_NAME as GET_ACCOUNT_CONTEXT,
  getAccountContext,
  getAccountContextInput,
  type ToolDeps
} from "./getAccountContext.js";

/**
 * The allowlist. Single source of truth for what the model may call.
 * A tool absent from this array cannot be invoked. PRD §10.2, §17.
 *
 * Milestone 1 ships one tool. The remaining eight arrive in Milestone 3.
 */
export const ALLOWED_TOOLS = [GET_ACCOUNT_CONTEXT] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export function isAllowedTool(name: string): name is AllowedTool {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

/** Build the tool set bound to one investigation's account scope. */
export function buildTools(deps: ToolDeps) {
  return {
    [GET_ACCOUNT_CONTEXT]: tool({
      description:
        "Look up the account being investigated: display name, plan type, " +
        "currency, tax status, primary zone, and available invoices. " +
        "Call this before answering any question about which account is in scope.",
      inputSchema: getAccountContextInput,
      execute: async (input) => await getAccountContext(input, deps)
    })
  };
}
