import { useMemo, useState } from "react";
import type { PlanningQuestion } from "@fusion/core";
import type { CeActivityTurn, CeConversationTurn, CeSession } from "../session/session-store.js";
import { canRenderRichly } from "./ce-question-support.js";

/**
 * CeFlow — the interactive renderer (U6).
 *
 * Renders the four interaction types CeFlow expresses richly (`text`,
 * `single_select`, `multi_select`, `confirm`), the FULL conversation so far —
 * past questions and answers as proper chat bubbles, the agent's working
 * traces (thinking / tool activity) as collapsible blocks — and, while a turn
 * runs, a LIVE working pane streaming the agent's current output.
 *
 * Steering: alongside any selectable question the user can attach free-text
 * guidance to their answer (`{value, comment}`) or send guidance WITHOUT
 * answering (`{feedback}`) — the stage system prompt instructs the agent to
 * treat both as first-class input.
 *
 * When a turn carries a question CeFlow CANNOT express, it degrades to a
 * plain chat view that is VISUALLY MARKED as degraded (R8/AE1) — the stage is
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

// ── Transcript parsing ───────────────────────────────────────────────────────

type DisplayItem =
  | { kind: "chat"; role: "user" | "agent"; text: string }
  | { kind: "qa-question"; question: PlanningQuestion }
  | { kind: "qa-answer"; question?: PlanningQuestion; response: unknown }
  | { kind: "activity"; turns: CeActivityTurn[] }
  | { kind: "complete" };

function tryParseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn the persisted history (chat turns + serialized control records) into
 * renderable items. Control records are no longer hidden — questions, answers,
 * and working traces are the conversation.
 */
function parseHistory(history: CeConversationTurn[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const questionsById = new Map<string, PlanningQuestion>();
  for (const turn of history) {
    const obj = tryParseJson(turn.text);
    if (obj && turn.role === "agent") {
      const q = obj.question as PlanningQuestion | undefined;
      if (q && typeof q.id === "string" && typeof q.question === "string") {
        questionsById.set(q.id, q);
        items.push({ kind: "qa-question", question: q });
        continue;
      }
      const activity = obj.activity as { turns?: CeActivityTurn[] } | undefined;
      if (activity && Array.isArray(activity.turns)) {
        items.push({ kind: "activity", turns: activity.turns });
        continue;
      }
      if (obj.complete === true) {
        items.push({ kind: "complete" });
        continue;
      }
    }
    if (obj && turn.role === "user" && "answer" in obj) {
      items.push({
        kind: "qa-answer",
        question: typeof obj.questionId === "string" ? questionsById.get(obj.questionId) : undefined,
        response: obj.answer,
      });
      continue;
    }
    items.push({ kind: "chat", role: turn.role, text: turn.text });
  }
  return items;
}

/** Human-readable rendering of an answer payload (option ids → labels). */
function formatAnswer(
  response: unknown,
  question?: PlanningQuestion,
): { main: string; comment?: string; feedbackOnly?: boolean } {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const r = response as Record<string, unknown>;
    if (typeof r.feedback === "string") return { main: r.feedback, feedbackOnly: true };
    if ("value" in r) {
      const base = formatAnswer(r.value, question);
      return {
        main: base.main,
        ...(typeof r.comment === "string" && r.comment ? { comment: r.comment } : {}),
      };
    }
  }
  const label = (id: unknown): string =>
    question?.options?.find((o) => o.id === id)?.label ?? String(id);
  if (Array.isArray(response)) return { main: response.map(label).join(", ") };
  if (typeof response === "boolean") return { main: response ? "Yes" : "No" };
  return { main: label(response) };
}

// ── Working-trace rendering ──────────────────────────────────────────────────

/** Render thinking/text/tool activity turns (persisted trace or live pane). */
function ActivityTrace({ turns, live }: { turns: CeActivityTurn[]; live?: boolean }) {
  return (
    <div
      className={`ce-flow-activity${live ? " is-live" : ""}`}
      data-testid={live ? "ce-flow-live-activity" : "ce-flow-activity-trace"}
    >
      {turns.map((t, i) =>
        t.kind === "tool" ? (
          <div
            key={i}
            className={`ce-activity-tool${t.isError ? " is-error" : t.done ? " is-done" : " is-running"}`}
            data-testid="ce-activity-tool"
          >
            <span className="ce-activity-tool-marker">{t.isError ? "✗" : t.done ? "✓" : "▸"}</span> {t.text}
          </div>
        ) : (
          <pre key={i} className={`ce-activity-block ce-activity-${t.kind}`} data-kind={t.kind}>
            {t.text}
          </pre>
        ),
      )}
    </div>
  );
}

/** Render the full conversation: chat, Q&A bubbles, and working traces. */
function Transcript({ history }: { history: CeConversationTurn[] }) {
  const items = useMemo(() => parseHistory(history), [history]);
  if (items.length === 0) return null;
  return (
    <ol className="ce-flow-transcript" data-testid="ce-flow-transcript">
      {items.map((item, i) => {
        switch (item.kind) {
          case "chat":
            return (
              <li key={i} className={`ce-flow-turn ce-flow-turn-${item.role}`} data-role={item.role}>
                <span className="ce-flow-turn-role">{item.role === "agent" ? "Agent" : "You"}</span>
                <span className="ce-flow-turn-text">{item.text}</span>
              </li>
            );
          case "qa-question":
            return (
              <li key={i} className="ce-flow-turn ce-flow-turn-agent ce-flow-turn-question" data-testid="ce-flow-past-question">
                <span className="ce-flow-turn-role">Agent asked</span>
                <span className="ce-flow-turn-text">{item.question.question}</span>
              </li>
            );
          case "qa-answer": {
            const a = formatAnswer(item.response, item.question);
            return (
              <li
                key={i}
                className={`ce-flow-turn ce-flow-turn-user ce-flow-turn-answer${a.feedbackOnly ? " is-steering" : ""}`}
                data-testid="ce-flow-past-answer"
              >
                <span className="ce-flow-turn-role">{a.feedbackOnly ? "You steered" : "You answered"}</span>
                <span className="ce-flow-turn-text">{a.main}</span>
                {a.comment ? (
                  <span className="ce-flow-turn-comment" data-testid="ce-flow-answer-comment">
                    {a.comment}
                  </span>
                ) : null}
              </li>
            );
          }
          case "activity":
            return (
              <li key={i} className="ce-flow-turn ce-flow-turn-agent ce-flow-turn-activity">
                <details className="ce-flow-activity-details" data-testid="ce-flow-activity">
                  <summary>Agent work ({item.turns.length} step{item.turns.length === 1 ? "" : "s"})</summary>
                  <ActivityTrace turns={item.turns} />
                </details>
              </li>
            );
          case "complete":
            return (
              <li key={i} className="ce-flow-turn ce-flow-turn-agent ce-flow-turn-done">
                <span className="ce-flow-turn-text">✓ Stage complete</span>
              </li>
            );
        }
      })}
    </ol>
  );
}

// ── Question rendering ───────────────────────────────────────────────────────

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

/**
 * Question panel with steering. Wraps the rich/degraded renderer and adds the
 * guidance channel for selectable questions:
 * - guidance typed + an option clicked  → `{value, comment}` (answer + steer),
 * - guidance typed + "Send guidance"    → `{feedback}` (steer without answering).
 * Free-text questions skip the extra box — their answer field already takes
 * the user's own words.
 */
function QuestionPanel({
  question,
  disabled,
  onAnswer,
}: {
  question: PlanningQuestion;
  disabled: boolean;
  onAnswer: (questionId: string, response: unknown) => void;
}) {
  const [guidance, setGuidance] = useState("");
  const rich = canRenderRichly(question);

  const submitWithGuidance = (questionId: string, response: unknown) => {
    const comment = guidance.trim();
    onAnswer(questionId, comment ? { value: response, comment } : response);
    setGuidance("");
  };

  const sendGuidanceOnly = () => {
    const feedback = guidance.trim();
    if (!feedback) return;
    onAnswer(question.id, { feedback });
    setGuidance("");
  };

  const showGuidance = rich && question.type !== "text";

  return (
    <div className="ce-flow-question-panel">
      {rich ? (
        <RichQuestion question={question} disabled={disabled} onAnswer={submitWithGuidance} />
      ) : (
        <DegradedQuestion question={question} disabled={disabled} onAnswer={onAnswer} />
      )}
      {showGuidance ? (
        <div className="ce-flow-guidance" data-testid="ce-flow-guidance">
          <label className="ce-flow-guidance-label" htmlFor="ce-flow-guidance-input">
            Steer in your own words (optional — attached to your answer, or sent on its own)
          </label>
          <div className="ce-flow-guidance-row">
            <textarea
              id="ce-flow-guidance-input"
              data-testid="ce-flow-guidance-input"
              value={guidance}
              disabled={disabled}
              onChange={(e) => setGuidance(e.target.value)}
              rows={2}
              placeholder="e.g. focus on the mobile flow, skip auth for now…"
            />
            <button
              type="button"
              className="btn"
              data-testid="ce-flow-guidance-send"
              disabled={disabled || !guidance.trim()}
              onClick={sendGuidanceOnly}
            >
              Send guidance
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Flow surface ─────────────────────────────────────────────────────────────

export function CeFlow(props: CeFlowProps) {
  const { session, busy, error, onAnswer, onResume, onClose } = props;

  const question = session?.currentQuestion ?? undefined;

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
  const working = status === "active" || status === "launching";

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

      {working || (busy && status !== "awaiting_input") ? (
        <div className="ce-flow-working" data-testid="ce-flow-thinking">
          <p className="ce-flow-working-label">
            <span className="ce-flow-pulse" aria-hidden="true" />
            Agent working…
          </p>
          {session.liveActivity && session.liveActivity.length > 0 ? (
            <ActivityTrace turns={session.liveActivity} live />
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="ce-flow-error" role="alert" data-testid="ce-flow-error">
          {error}
        </p>
      ) : null}

      {status === "awaiting_input" && question ? (
        <QuestionPanel question={question} disabled={Boolean(busy)} onAnswer={onAnswer} />
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
