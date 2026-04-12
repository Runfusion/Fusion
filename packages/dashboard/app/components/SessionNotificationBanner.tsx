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

export function SessionNotificationBanner({
  sessions,
  onResumeSession,
  onDismissSession,
  onDismissAll,
}: SessionNotificationBannerProps) {
  const [dismissedSessionIds, setDismissedSessionIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setDismissedSessionIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      const next = new Set<string>();
      let changed = false;

      for (const id of previous) {
        const session = sessionById.get(id);
        // Preserve dismissed IDs for awaiting_input and error sessions
        if (session && (session.status === "awaiting_input" || session.status === "error")) {
          next.add(id);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [sessions]);

  const sessionsNeedingInput = useMemo(
    () =>
      sessions.filter(
        (session) =>
          (session.status === "awaiting_input" || session.status === "error") &&
          !dismissedSessionIds.has(session.id),
      ),
    [dismissedSessionIds, sessions],
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
    setDismissedSessionIds((previous) => {
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  };

  const handleResume = (session: AiSessionSummary) => {
    setDismissedSessionIds((previous) => {
      if (!previous.has(session.id)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(session.id);
      return next;
    });
    onResumeSession(session);
  };

  const handleDismissAll = () => {
    setDismissedSessionIds((previous) => {
      const next = new Set(previous);
      for (const session of sessionsNeedingInput) {
        next.add(session.id);
      }
      return next;
    });
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
