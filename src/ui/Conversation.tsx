import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

function stepsOf(message: UIMessage): string[] {
  return message.parts
    .filter((part) => part.type.startsWith("tool-"))
    .map((part) => part.type.replace(/^tool-/, ""));
}

/**
 * Renders the small subset of Markdown the agent emits (bold headings and
 * dash bullets) without pulling in a Markdown renderer, since the shape of the
 * summary is fixed by `renderSummary`.
 */
function Rendered({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (trimmed === "") return <br key={index} />;

        const heading = trimmed.match(/^\*\*(.+?)\*\*\s*(.*)$/);
        if (heading) {
          return (
            <p key={index}>
              <strong>{heading[1]}</strong>
              {heading[2] ? ` ${heading[2]}` : ""}
            </p>
          );
        }
        if (trimmed.startsWith("- ")) {
          return (
            <p key={index} className="bullet">
              {trimmed.slice(2)}
            </p>
          );
        }
        return <p key={index}>{trimmed}</p>;
      })}
    </>
  );
}

interface Props {
  messages: UIMessage[];
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  suggestedPrompt: string;
  onSuggested: () => void;
  canSend: boolean;
}

export function Conversation({
  messages,
  busy,
  error,
  onRetry,
  suggestedPrompt,
  onSuggested,
  canSend
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  return (
    <div
      className="messages"
      aria-live="polite"
      aria-busy={busy}
      aria-label="Conversation"
    >
      {messages.length === 0 && !busy && (
        <div className="empty">
          <h2>Start an investigation</h2>
          <p>
            This agent runs a bounded invoice-variance playbook against read-only
            billing tools. Ask the suggested question, or your own.
          </p>
          <button
            type="button"
            className="suggestion"
            onClick={onSuggested}
            disabled={!canSend}
          >
            {suggestedPrompt}
          </button>
        </div>
      )}

      {messages.map((message) => {
        const text = textOf(message);
        const steps = stepsOf(message);
        return (
          <article key={message.id} className={`message message--${message.role}`}>
            <div className="message__role">
              {message.role === "user" ? "You" : "Agent"}
            </div>
            {steps.length > 0 && (
              <ul className="message__steps">
                {steps.map((step, i) => (
                  <li key={`${step}-${i}`}>{step}</li>
                ))}
              </ul>
            )}
            {text && (
              <div className="message__text">
                <Rendered text={text} />
              </div>
            )}
          </article>
        );
      })}

      {busy && (
        <div className="thinking" role="status">
          <span className="skeleton skeleton--line" aria-hidden="true" />
          <span className="skeleton skeleton--line short" aria-hidden="true" />
          Investigating — running read-only billing tools…
        </div>
      )}

      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={onRetry} disabled={!canSend}>
            Retry
          </button>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
