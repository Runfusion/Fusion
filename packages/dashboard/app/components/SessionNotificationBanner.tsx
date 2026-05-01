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

const STORAGE_KEY = "fusion:session-banner-dismissed";

function loadDismissedFromStorage(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function persistDismissed(map: Map<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of map) obj[k] = v;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore quota / disabled storage
  }
}

// Map of sessionId → the updatedAt at which it was dismissed. The banner
// re-shows the session when its updatedAt advances past the recorded value
// (i.e. a new request/question arrived). Persisted to localStorage so
// dismissals survive page refresh.
export const dismissedIds = loadDismissedFromStorage();

export function SessionNotificationBanner({
  sessions,
  onResumeSession,
  onDismissSession,
  onDismissAll,
}: SessionNotificationBannerProps) {
  const [dismissRevision, setDismissRevision] = useState(0);
  const bump = () => {
    persistDismissed(dismissedIds);
    setDismissRevision((n) => n + 1);
  };

  // Prune stored dismissals when sessions advance past the dismissed
  // updatedAt (new question arrived) or are no longer in a notify-worthy
  // state. This keeps localStorage from accumulating stale entries.
  useEffect(() => {
    if (dismissedIds.size === 0) return;

    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    let pruned = false;

    for (const [id, dismissedAt] of dismissedIds) {
      const session = sessionById.get(id);
      if (!session) continue;
      const stillNotifying = session.status === "awaiting_input" || session.status === "error";
      if (!stillNotifying) {
        dismissedIds.delete(id);
        pruned = true;
        continue;
      }
      if (session.updatedAt && session.updatedAt !== dismissedAt) {
        dismissedIds.delete(id);
        pruned = true;
      }
    }

    if (pruned) bump();
  }, [sessions]);

  const sessionsNeedingInput = useMemo(
    () =>
      sessions.filter((session) => {
        if (session.status !== "awaiting_input" && session.status !== "error") return false;
        const dismissedAt = dismissedIds.get(session.id);
        if (dismissedAt === undefined) return true;
        return session.updatedAt !== dismissedAt;
      }),
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

  const dismissLocally = (session: AiSessionSummary) => {
    dismissedIds.set(session.id, session.updatedAt ?? "");
    bump();
  };

  const handleResume = (session: AiSessionSummary) => {
    dismissedIds.delete(session.id);
    bump();
    onResumeSession(session);
  };

  const handleDismissAll = () => {
    for (const session of sessionsNeedingInput) {
      dismissedIds.set(session.id, session.updatedAt ?? "");
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
                    dismissLocally(session);
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
