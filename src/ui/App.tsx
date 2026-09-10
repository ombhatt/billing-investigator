import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { AccountHeader } from "./AccountHeader.js";
import { Conversation } from "./Conversation.js";
import { InvestigationPanel } from "./InvestigationPanel.js";
import type { AccountSummary, AgentState, TabId } from "./types.js";

const ACCOUNT_ID = "abc123";

/** PRD §7.1. */
const SUGGESTED_PROMPT =
  "Why is account abc123's August invoice higher than July, and is the bill correct?";

/**
 * One shared demo session. A real deployment would key this per investigation;
 * P0 is a single-account demo and PRD §4.2 rules out multi-tenancy.
 */
const SESSION_NAME = "demo-abc123";

export default function App() {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<TabId>("plan");
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const agent = useAgent<AgentState>({
    agent: "BillingInvestigatorAgent",
    name: SESSION_NAME,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const { messages, sendMessage, clearHistory, status, error } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const investigation = agent.state?.investigation ?? null;
  const busy = status === "streaming" || status === "submitted";
  // Sending before the socket is open drops the message silently.
  const canSend = connected && !busy;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/accounts/${ACCOUNT_ID}`)
      .then(async (response) => {
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setAccountError(
            (body as { error?: { message?: string } }).error?.message ??
              "Unavailable"
          );
          return;
        }
        setAccount(body as AccountSummary);
      })
      .catch(() => {
        if (!cancelled) setAccountError("Unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the investigation as it progresses, but never override a tab the
  // reader chose themselves mid-run.
  const autoTab = useRef(true);
  useEffect(() => {
    if (!autoTab.current || !investigation) return;
    if (investigation.summary) setTab("summary");
    else if (busy) setTab("plan");
  }, [investigation, busy]);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !canSend) return;
      autoTab.current = true;
      setLastQuestion(trimmed);
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
      setInput("");
    },
    [canSend, sendMessage]
  );

  const resetDemo = useCallback(() => {
    // Clears the conversation and this agent's investigation record only.
    // Seeded billing data in D1 is never touched — every tool is read-only.
    clearHistory();
    agent.setState({ investigation: null });
    setTab("plan");
    autoTab.current = true;
    setLastQuestion(null);
  }, [agent, clearHistory]);

  const selectTab = useCallback((next: TabId) => {
    autoTab.current = false;
    setTab(next);
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Billing Investigator</h1>
          <p className="masthead__tagline">
            Read-only AI agent that investigates invoice-variance questions.
          </p>
        </div>
        <div className="masthead__status">
          <span className="badge badge--synthetic">Synthetic demo data</span>
          <span className="conn" role="status">
            <span
              className={`conn__dot ${connected ? "conn__dot--on" : ""}`}
              aria-hidden="true"
            />
            {connected ? "Connected" : "Connecting…"}
          </span>
          <button type="button" className="secondary" onClick={resetDemo}>
            Reset demo
          </button>
        </div>
      </header>

      <AccountHeader account={account} error={accountError} />

      <div className="columns">
        <section className="conversation" aria-label="Conversation">
          <Conversation
            messages={messages}
            busy={busy}
            error={error ? "The agent could not complete that turn." : null}
            onRetry={() => lastQuestion && submit(lastQuestion)}
            suggestedPrompt={SUGGESTED_PROMPT}
            onSuggested={() => submit(SUGGESTED_PROMPT)}
            canSend={canSend}
          />

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit(input);
            }}
          >
            <label htmlFor="question" className="visually-hidden">
              Ask a billing question
            </label>
            <input
              id="question"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                connected ? "Ask a billing question…" : "Connecting…"
              }
              autoComplete="off"
              disabled={!canSend}
            />
            <button type="submit" disabled={!canSend || !input.trim()}>
              Send
            </button>
          </form>
        </section>

        <InvestigationPanel
          investigation={investigation}
          active={tab}
          onSelect={selectTab}
          busy={busy}
        />
      </div>

      <footer className="footer">
        All customer, contract, pricing, usage and invoice data is synthetic and
        fictional. Prices and pipeline boundaries are illustrative and do not
        reflect Cloudflare pricing. This tool is read-only: it never changes
        contracts, usage, invoices, credits or payments, and “appears correct” is
        an operational assessment, not a financial certification.
      </footer>
    </div>
  );
}
