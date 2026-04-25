import "./SessionNotificationBanner.css";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Lightbulb, Layers, Target, X } from "lucide-react";
import type { AiSessionSummary } from "../api";

interface SessionNotificationBannerProps {
  sessions: AiSessionSummary[];
  onResumeSession: (session: AiSessionSummary) => void;
  onDismissSession: (id: string) => void;
  onDismissAll: () => void;
}

const TYPE_ICONS = {
  planning: Lightbulb,
  subtask: Layers,
  mission_interview: Target,
  milestone_interview: Target,
  slice_interview: Target,
} as const;

const TYPE_LABELS = {
  planning: "Planning",
  subtask: "Subtask Breakdown",
  mission_interview: "Mission Interview",
  milestone_interview: "Milestone Interview",
  slice_interview: "Slice Interview",
} as const;

export const dismissedIds = new Set<string>();

export function SessionNotificationBanner({
  sessions,
  onResumeSession,
  onDismissSession,
  onDismissAll,
}: SessionNotificationBannerProps) {
  // Bump counter to trigger useMemo recomputation when dismissedIds mutates
  const [dismissRevision, setDismissRevision] = useState(0);
  const bump = () => setDismissRevision((n) => n + 1);

  // Prune dismissed IDs for sessions that are no longer awaiting_input/error
  useEffect(() => {
    if (dismissedIds.size === 0) return;

    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    let pruned = false;

    for (const id of dismissedIds) {
      const session = sessionById.get(id);
      if (session && session.status !== "awaiting_input" && session.status !== "error") {
        dismissedIds.delete(id);
        pruned = true;
      }
    }

    if (pruned) bump();
  }, [sessions]);

  const sessionsNeedingInput = useMemo(
    () =>
      sessions.filter(
        (session) =>
          (session.status === "awaiting_input" || session.status === "error") &&
          !dismissedIds.has(session.id),
      ),
    // dismissRevision is a stable counter that bumps whenever dismissedIds changes
    [sessions, dismissRevision],
  );

  if (sessionsNeedingInput.length === 0) {
    return null;
  }

  const awaitingInputCount = sessionsNeedingInput.filter((s) => s.status === "awaiting_input").length;
  const errorCount = sessionsNeedingInput.filter((s) => s.status === "error").length;

  let headerText = "";
  if (awaitingInputCount > 0 && errorCount > 0) {
    headerText = `${awaitingInputCount} AI session${awaitingInputCount === 1 ? "" : "s"} need${awaitingInputCount === 1 ? "s" : ""} your input, ${errorCount} failed`;
  } else if (awaitingInputCount > 0) {
    headerText = `${awaitingInputCount} AI session${awaitingInputCount === 1 ? "" : "s"} need${awaitingInputCount === 1 ? "s" : ""} your input`;
  } else if (errorCount > 0) {
    headerText = `${errorCount} AI session${errorCount === 1 ? "" : "s"} failed`;
  }

  const dismissLocally = (id: string) => {
    dismissedIds.add(id);
    bump();
  };

  const handleResume = (session: AiSessionSummary) => {
    dismissedIds.delete(session.id);
    bump();
    onResumeSession(session);
  };

  const handleDismissAll = () => {
    for (const session of sessionsNeedingInput) {
      dismissedIds.add(session.id);
    }
    bump();
    onDismissAll();
  };

  return (
    <section className="session-notification-banner" role="region" aria-live="polite" aria-label="AI sessions needing input or failed">
      <div className="session-notification-banner__header">
        <div className="session-notification-banner__headline">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{headerText}</span>
        </div>
        <button className="session-notification-banner__dismiss-all" onClick={handleDismissAll}>
          <X size={14} aria-hidden="true" />
          <span>Dismiss all</span>
        </button>
      </div>

      <div className="session-notification-banner__list">
        {sessionsNeedingInput.map((session) => {
          const Icon = TYPE_ICONS[session.type];
          const isError = session.status === "error";

          return (
            <article
              className={`session-notification-banner__item${isError ? " session-notification-banner__item--error" : ""}`}
              key={session.id}
              data-session-type={session.type}
              data-session-status={session.status}
            >
              <div className="session-notification-banner__item-main">
                {isError ? (
                  <AlertCircle size={16} className="session-notification-banner__type-icon session-notification-banner__type-icon--error" aria-hidden="true" />
                ) : (
                  <Icon size={16} className="session-notification-banner__type-icon" aria-hidden="true" />
                )}
                <div className="session-notification-banner__text">
                  <p className="session-notification-banner__title" title={session.title}>{session.title}</p>
                  <p className="session-notification-banner__meta">
                    {isError ? "Failed" : TYPE_LABELS[session.type]}
                  </p>
                </div>
              </div>

              <div className="session-notification-banner__actions">
                <button className="session-notification-banner__resume" onClick={() => handleResume(session)}>
                  {isError ? "Retry" : "Resume"}
                </button>
                <button
                  className="session-notification-banner__dismiss"
                  onClick={() => {
                    dismissLocally(session.id);
                    onDismissSession(session.id);
                  }}
                  aria-label={`Dismiss ${session.title}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
