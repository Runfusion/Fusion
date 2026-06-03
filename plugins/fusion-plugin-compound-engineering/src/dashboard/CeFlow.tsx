import { useMemo, useState } from "react";
import type { PlanningQuestion } from "@fusion/core";
import type { CeConversationTurn, CeSession } from "../session/session-store.js";
import { canRenderRichly } from "./ce-question-support.js";

/**
 * CeFlow — the interactive renderer (U6).
 *
 * Renders the four interaction types CeFlow expresses richly (`text`,
 * `single_select`, `multi_select`, `confirm`) plus streamed `thinking`/`text`
 * history. When a turn carries a question CeFlow CANNOT express, it degrades to
 * a plain chat view that is VISUALLY MARKED as degraded (R8/AE1) — the stage is
 * still completable there via a free-text answer.
 *
 * It does NOT import `PlanningModeModal` or any dashboard internal (KTD3 scope
 * boundary); it only consumes the `PlanningQuestion` shape for parity.
 */

export interface CeFlowProps {
  session?: CeSession;
  busy?: boolean;
  error?: string;
  /** Submit an answer to the current question. */
  onAnswer: (questionId: string, response: unknown) => void;
  /** Resume an interrupted/error session. */
  onResume?: () => void;
  /** Back to the launcher. */
  onClose?: () => void;
}

/** Render the agent/user conversation so far (streamed thinking/text). */
function Transcript({ history }: { history: CeConversationTurn[] }) {
  const visible = history.filter((t) => {
    // Hide serialized question/answer/complete markers from the readable
    // transcript; they are control records, not chat.
    if (t.role === "agent" && /^\{"(question|complete)"/.test(t.text)) return false;
    if (t.role === "user" && /^\{"answer"/.test(t.text)) return false;
    return true;
  });
  if (visible.length === 0) return null;
  return (
    <ol className="ce-flow-transcript" data-testid="ce-flow-transcript">
      {visible.map((turn, i) => (
        <li key={i} className={`ce-flow-turn ce-flow-turn-${turn.role}`} data-role={turn.role}>
          <span className="ce-flow-turn-role">{turn.role === "agent" ? "Agent" : "You"}</span>
          <span className="ce-flow-turn-text">{turn.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Rich renderer for a single supported question type. */
function RichQuestion({
  question,
  disabled,
  onAnswer,
}: {
  question: PlanningQuestion;
  disabled: boolean;
  onAnswer: (questionId: string, response: unknown) => void;
}) {
  const [text, setText] = useState("");
  const [multi, setMulti] = useState<string[]>([]);

  const submit = (response: unknown) => onAnswer(question.id, response);

  return (
    <div className="ce-flow-question" data-testid="ce-flow-question" data-qtype={question.type}>
      <p className="ce-flow-question-text">{question.question}</p>
      {question.description ? <p className="ce-flow-question-desc">{question.description}</p> : null}

      {question.type === "text" ? (
        <form
          className="ce-flow-text"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) submit(text.trim());
          }}
        >
          <textarea
            data-testid="ce-flow-text-input"
            aria-label={question.question}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            rows={3}
          />
          <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>
            Send
          </button>
        </form>
      ) : null}

      {question.type === "confirm" ? (
        <div className="ce-flow-confirm">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="ce-flow-confirm-yes"
            disabled={disabled}
            onClick={() => submit(true)}
          >
            Yes
          </button>
          <button
            type="button"
            className="btn"
            data-testid="ce-flow-confirm-no"
            disabled={disabled}
            onClick={() => submit(false)}
          >
            No
          </button>
        </div>
      ) : null}

      {question.type === "single_select" ? (
        <ul className="ce-flow-options" data-testid="ce-flow-single">
          {(question.options ?? []).map((opt) => (
            <li key={opt.id}>
              <button
                type="button"
                className="ce-flow-option btn"
                data-option={opt.id}
                disabled={disabled}
                onClick={() => submit(opt.id)}
              >
                <span className="ce-flow-option-label">{opt.label}</span>
                {opt.description ? <span className="ce-flow-option-desc">{opt.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {question.type === "multi_select" ? (
        <form
          className="ce-flow-options"
          data-testid="ce-flow-multi"
          onSubmit={(e) => {
            e.preventDefault();
            submit(multi);
          }}
        >
          <ul>
            {(question.options ?? []).map((opt) => {
              const checked = multi.includes(opt.id);
              return (
                <li key={opt.id}>
                  <label className="ce-flow-checkbox">
                    <input
                      type="checkbox"
                      data-option={opt.id}
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) =>
                        setMulti((prev) =>
                          e.target.checked ? [...prev, opt.id] : prev.filter((id) => id !== opt.id),
                        )
                      }
                    />
                    <span className="ce-flow-option-label">{opt.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button type="submit" className="btn btn-primary" data-testid="ce-flow-multi-submit" disabled={disabled}>
            Confirm selection
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Degraded chat fallback (R8/AE1). Used when a question can't be expressed by
 * the rich renderer. Visibly marked as degraded; the stage is still completable
 * because the user can answer in free text, which is submitted back through the
 * same answer route.
 */
function DegradedQuestion({
  question,
  disabled,
  onAnswer,
}: {
  question: PlanningQuestion;
  disabled: boolean;
  onAnswer: (questionId: string, response: unknown) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="ce-flow-question ce-flow-degraded" data-testid="ce-flow-degraded" data-qtype={question.type}>
      <p className="ce-flow-degraded-banner" role="status" data-testid="ce-flow-degraded-banner">
        ⚠ Chat fallback — this prompt can&apos;t be shown as buttons here. Answer in your own words below.
      </p>
      <p className="ce-flow-question-text">{question.question}</p>
      {question.description ? <p className="ce-flow-question-desc">{question.description}</p> : null}
      {Array.isArray(question.options) && question.options.length > 0 ? (
        <ul className="ce-flow-degraded-options">
          {question.options.map((opt) => (
            <li key={opt.id}>{opt.label}</li>
          ))}
        </ul>
      ) : null}
      <form
        className="ce-flow-text"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onAnswer(question.id, text.trim());
        }}
      >
        <textarea
          data-testid="ce-flow-degraded-input"
          aria-label={question.question}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export function CeFlow(props: CeFlowProps) {
  const { session, busy, error, onAnswer, onResume, onClose } = props;

  const question = session?.currentQuestion ?? undefined;
  const rich = useMemo(() => (question ? canRenderRichly(question) : false), [question]);

  if (!session) {
    return (
      <div className="ce-flow card" data-testid="ce-flow-empty">
        <p>No active session.</p>
        {onClose ? (
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
        ) : null}
      </div>
    );
  }

  const status = session.status;
  const settledTerminal = status === "completed";
  const recoverable = status === "interrupted" || status === "error";

  return (
    <div className="ce-flow card" data-testid="ce-flow" data-status={status} data-stage={session.stage}>
      <header className="ce-flow-header">
        <h3>{session.stage}</h3>
        <span className="ce-flow-status" data-testid="ce-flow-status">
          {status.replace("_", " ")}
        </span>
        {onClose ? (
          <button type="button" className="btn ce-flow-close" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      <Transcript history={session.conversationHistory} />

      {busy && status !== "awaiting_input" ? (
        <p className="ce-flow-thinking" data-testid="ce-flow-thinking">
          Thinking…
        </p>
      ) : null}

      {error ? (
        <p className="ce-flow-error" role="alert" data-testid="ce-flow-error">
          {error}
        </p>
      ) : null}

      {status === "awaiting_input" && question ? (
        rich ? (
          <RichQuestion question={question} disabled={Boolean(busy)} onAnswer={onAnswer} />
        ) : (
          <DegradedQuestion question={question} disabled={Boolean(busy)} onAnswer={onAnswer} />
        )
      ) : null}

      {recoverable ? (
        <div className="ce-flow-recover" data-testid="ce-flow-recover">
          <p className="ce-flow-error" role="alert">
            Session {status}{session.error ? `: ${session.error}` : ""}.
          </p>
          {onResume ? (
            <button type="button" className="btn btn-primary" data-testid="ce-flow-resume" onClick={onResume} disabled={Boolean(busy)}>
              Resume
            </button>
          ) : null}
        </div>
      ) : null}

      {settledTerminal ? (
        <div className="ce-flow-complete" data-testid="ce-flow-complete">
          <p>Stage complete.</p>
          {session.artifactPath ? (
            <p className="ce-flow-artifact-path" data-testid="ce-flow-artifact-path">
              Artifact: {session.artifactPath}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default CeFlow;
