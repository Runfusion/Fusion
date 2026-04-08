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
} as const;

const TYPE_LABELS = {
  planning: "Planning",
  subtask: "Subtask Breakdown",
  mission_interview: "Mission Interview",
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
        if (session && session.status === "awaiting_input") {
          next.add(id);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [sessions]);

  const sessionsNeedingInput = useMemo(
    () => sessions.filter((session) => session.status === "awaiting_input" && !dismissedSessionIds.has(session.id)),
    [dismissedSessionIds, sessions],
  );

  if (sessionsNeedingInput.length === 0) {
    return null;
  }

  const count = sessionsNeedingInput.length;
  const headerText = `${count} AI session${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your input`;

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
    <section className="session-notification-banner" role="region" aria-live="polite" aria-label="AI sessions needing input">
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

          return (
            <article className="session-notification-banner__item" key={session.id} data-session-type={session.type}>
              <div className="session-notification-banner__item-main">
                <Icon size={16} className="session-notification-banner__type-icon" aria-hidden="true" />
                <div className="session-notification-banner__text">
                  <p className="session-notification-banner__title" title={session.title}>{session.title}</p>
                  <p className="session-notification-banner__meta">{TYPE_LABELS[session.type]}</p>
                </div>
              </div>

              <div className="session-notification-banner__actions">
                <button className="session-notification-banner__resume" onClick={() => handleResume(session)}>
                  Resume
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
