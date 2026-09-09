import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import type { BillingInvestigatorAgent } from "./server.js";

/**
 * A fixed session name so a browser refresh reconnects to the same Durable
 * Object and the conversation is restored. Milestone 4 replaces this with a
 * real investigation id.
 */
const SESSION_NAME = "demo-abc123";

const SUGGESTED_PROMPT = "What account am I investigating?";

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

function toolNames(message: UIMessage): string[] {
  return message.parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => part.type.replace(/^tool-/, ""));
}

export default function App() {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const agent = useAgent<BillingInvestigatorAgent>({
    agent: "BillingInvestigatorAgent",
    name: SESSION_NAME,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isBusy = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isBusy) inputRef.current?.focus();
  }, [isBusy]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isBusy) return;
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
      setInput("");
    },
    [isBusy, sendMessage]
  );

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>Billing Investigator</h1>
          <p className="subtitle">
            Read-only billing investigation agent ·{" "}
            <code className="mono">abc123</code>
          </p>
        </div>
        <div className="header-right">
          <span className="badge">Synthetic demo data</span>
          <span className="status" role="status">
            {connected ? "Connected" : "Connecting…"}
          </span>
        </div>
      </header>

      <section className="messages" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && (
          <div className="empty">
            <p>Milestone 1 smoke test. Ask:</p>
            <button
              type="button"
              className="suggestion"
              onClick={() => submit(SUGGESTED_PROMPT)}
              disabled={isBusy}
            >
              {SUGGESTED_PROMPT}
            </button>
          </div>
        )}

        {messages.map((message) => {
          const text = messageText(message);
          const tools = toolNames(message);
          return (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="role">
                {message.role === "user" ? "You" : "Agent"}
              </div>
              {tools.length > 0 && (
                <ul className="tools">
                  {tools.map((name, i) => (
                    <li key={`${name}-${i}`} className="mono">
                      Called {name}
                    </li>
                  ))}
                </ul>
              )}
              {text && <div className="text">{text}</div>}
            </article>
          );
        })}

        {isBusy && <p className="thinking">Investigating…</p>}
        <div ref={endRef} />
      </section>

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
          placeholder="Ask a billing question…"
          autoComplete="off"
          disabled={isBusy}
        />
        <button type="submit" disabled={isBusy || !input.trim()}>
          Send
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => clearHistory()}
          disabled={isBusy}
        >
          Reset
        </button>
      </form>

      <footer className="footer">
        All customer, contract, pricing, usage, and invoice data is synthetic.
      </footer>
    </main>
  );
}
