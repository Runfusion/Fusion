import "./SessionNotificationBanner.css";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Lightbulb, Layers, LoaderCircle, Target, Terminal, X } from "lucide-react";
import type { AiSessionSummary, CliNeedsAttentionVariant } from "../api";

export type CliActionId = "advance" | "retry" | "cancel" | "reauthenticate" | "relaunch";

interface SessionNotificationBannerProps {
  sessions: AiSessionSummary[];
  onResumeSession: (session: AiSessionSummary) => void;
  onDismissSession: (id: string) => void;
  onDismissAll: () => void;
  /**
   * CLI agent needs-attention / confirm-advance actions (CLI Agent Executor,
   * U11). Every enabled CLI action must have an observable effect in the host;
   * unsupported actions should be returned from `getCliActionDisabledReason`.
   */
  onCliAction?: (session: AiSessionSummary, action: CliActionId) => void;
  getCliActionDisabledReason?: (session: AiSessionSummary, action: CliActionId) => string | null | undefined;
}

// `cli-agent` extends the previously-closed union: a SINGLE Terminal icon for
// all adapters (reusing the banner without this entry crashes on the unknown
// type — the union-regression the U11 tests guard).
const TYPE_ICONS = {
  planning: Lightbulb,
  subtask: Layers,
  mission_interview: Target,
  milestone_interview: Target,
  slice_interview: Target,
  "cli-agent": Terminal,
} as const;

const TYPE_LABEL_KEYS: Record<keyof typeof TYPE_ICONS, { key: string; defaultVal: string }> = {
  planning: { key: "sessionBanner.typeLabel.planning", defaultVal: "Planning" },
  subtask: { key: "sessionBanner.typeLabel.subtask", defaultVal: "Subtask Breakdown" },
  mission_interview: { key: "sessionBanner.typeLabel.missionInterview", defaultVal: "Mission Interview" },
  milestone_interview: { key: "sessionBanner.typeLabel.milestoneInterview", defaultVal: "Milestone Interview" },
  slice_interview: { key: "sessionBanner.typeLabel.sliceInterview", defaultVal: "Slice Interview" },
  "cli-agent": { key: "sessionBanner.typeLabel.cliAgent", defaultVal: "CLI Agent" },
};

/** Action verb defaults (i18n) for each pinned needs-attention variant. */
const CLI_ACTION_LABELS: Record<CliActionId, { key: string; defaultVal: string }> = {
  advance: { key: "sessionBanner.cli.advance", defaultVal: "Advance" },
  retry: { key: "sessionBanner.cli.retry", defaultVal: "Retry" },
  cancel: { key: "sessionBanner.cli.cancelTask", defaultVal: "Cancel task" },
  reauthenticate: { key: "sessionBanner.cli.reauthenticate", defaultVal: "Re-authenticate" },
  relaunch: { key: "sessionBanner.cli.relaunch", defaultVal: "Relaunch fresh" },
};

/** Pinned copy + ordered actions per needs-attention variant (U11). */
const CLI_VARIANT_SPEC: Record<
  CliNeedsAttentionVariant,
  { messageKey: string; messageDefault: string; actions: CliActionId[] }
> = {
  userExited: {
    messageKey: "sessionBanner.cli.userExited",
    messageDefault: "Agent exited before completing",
    actions: ["advance", "retry", "cancel"],
  },
  authFailed: {
    messageKey: "sessionBanner.cli.authFailed",
    messageDefault: "CLI authentication failed",
    actions: ["reauthenticate", "retry"],
  },
  "resume-exhausted": {
    messageKey: "sessionBanner.cli.resumeExhausted",
    messageDefault: "Couldn't resume the session",
    actions: ["relaunch", "cancel"],
  },
};

const STORAGE_KEY = "fusion:session-banner-dismissed";

function parseUpdatedAtMs(value: string | undefined | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function loadDismissedFromStorage(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, number | string>;
    const result = new Map<string, number>();
    for (const [k, v] of Object.entries(parsed)) {
      // Accept legacy string-based entries (treated as opaque dismissal markers
      // by parsing as date — yields 0 if not a date, which suppresses banners
      // until the session next advances).
      const num = typeof v === "number" ? v : parseUpdatedAtMs(v);
      result.set(k, num);
    }
    return result;
  } catch {
    return new Map();
  }
}

function persistDismissed(map: Map<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of map) obj[k] = v;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore quota / disabled storage
  }
}

/**
 * Statuses that warrant a banner entry. Extended for CLI agent sessions:
 * `waiting_on_input` (F2) and `needs_attention` (pinned variants) join the
 * existing `awaiting_input` / `error`; FN-8229 also retains non-planning
 * `generating` progress after removing the footer AI pill.
 */
function isNotifyingStatus(status: AiSessionSummary["status"]): boolean {
  return (
    status === "awaiting_input" ||
    status === "error" ||
    status === "waiting_on_input" ||
    status === "needs_attention" ||
    status === "generating"
  );
}

// Map of sessionId → epoch-ms timestamp at which the user dismissed the
// banner for that session. The banner re-shows the session only when the
// session's `updatedAt` advances strictly past the recorded dismissal time
// (i.e. a new question/event arrived after the user dismissed). Persisted
// to localStorage so dismissals survive page refresh.
export const dismissedIds = loadDismissedFromStorage();

export function SessionNotificationBanner({
  sessions,
  onResumeSession,
  onDismissSession,
  onDismissAll,
  onCliAction,
  getCliActionDisabledReason,
}: SessionNotificationBannerProps) {
  const { t } = useTranslation("app");
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

    for (const [id, dismissedAtMs] of dismissedIds) {
      const session = sessionById.get(id);
      if (!session) continue;
      const stillNotifying = isNotifyingStatus(session.status);
      if (!stillNotifying) {
        dismissedIds.delete(id);
        pruned = true;
        continue;
      }
      const sessionMs = parseUpdatedAtMs(session.updatedAt);
      if (sessionMs > dismissedAtMs) {
        dismissedIds.delete(id);
        pruned = true;
      }
    }

    if (pruned) bump();
  }, [sessions]);

  const sessionsNeedingInput = useMemo(
    () =>
      sessions.filter((session) => {
        if (!isNotifyingStatus(session.status)) return false;
        const dismissedAtMs = dismissedIds.get(session.id);
        if (dismissedAtMs === undefined) return true;
        return parseUpdatedAtMs(session.updatedAt) > dismissedAtMs;
      }),
    [sessions, dismissRevision],
  );

  if (sessionsNeedingInput.length === 0) {
    return null;
  }

  // CLI `waiting_on_input` rolls into the "needs input" count; `needs_attention`
  // rolls into the "failed" count for the summary header.
  const awaitingInputCount = sessionsNeedingInput.filter(
    (s) => s.status === "awaiting_input" || s.status === "waiting_on_input",
  ).length;
  const errorCount = sessionsNeedingInput.filter(
    (s) => s.status === "error" || s.status === "needs_attention",
  ).length;
  const generatingCount = sessionsNeedingInput.filter((s) => s.status === "generating").length;

  let headerText = "";
  if (generatingCount > 0 && (awaitingInputCount > 0 || errorCount > 0)) {
    headerText = t(
      "sessionBanner.headerMixed",
      "{{generatingCount}} AI sessions in progress, {{actionableCount}} need attention",
      { generatingCount, actionableCount: awaitingInputCount + errorCount },
    );
  } else if (generatingCount > 0) {
    headerText = t(
      generatingCount === 1 ? "sessionBanner.headerGeneratingSingular" : "sessionBanner.headerGeneratingPlural",
      generatingCount === 1 ? "{{count}} AI session in progress" : "{{count}} AI sessions in progress",
      { count: generatingCount },
    );
  } else if (awaitingInputCount > 0 && errorCount > 0) {
    headerText = t(
      awaitingInputCount === 1
        ? "sessionBanner.headerAwaitingAndErrorSingular"
        : "sessionBanner.headerAwaitingAndErrorPlural",
      awaitingInputCount === 1
        ? "{{awaitingCount}} AI session needs your input, {{errorCount}} failed"
        : "{{awaitingCount}} AI sessions need your input, {{errorCount}} failed",
      { awaitingCount: awaitingInputCount, errorCount },
    );
  } else if (awaitingInputCount > 0) {
    headerText = t(
      awaitingInputCount === 1
        ? "sessionBanner.headerAwaitingSingular"
        : "sessionBanner.headerAwaitingPlural",
      awaitingInputCount === 1
        ? "{{count}} AI session needs your input"
        : "{{count}} AI sessions need your input",
      { count: awaitingInputCount },
    );
  } else if (errorCount > 0) {
    headerText = t(
      errorCount === 1
        ? "sessionBanner.headerErrorSingular"
        : "sessionBanner.headerErrorPlural",
      errorCount === 1
        ? "{{count}} AI session failed"
        : "{{count}} AI sessions failed",
      { count: errorCount },
    );
  }

  const dismissLocally = (session: AiSessionSummary) => {
    // Record dismissal at "now" so any session update strictly newer than
    // this point will re-surface the banner. Using the session's current
    // updatedAt was unreliable: lock heartbeats and unrelated server-side
    // touches advance updatedAt on the same content, which would otherwise
    // re-show a banner the user just dismissed.
    dismissedIds.set(session.id, Math.max(parseUpdatedAtMs(session.updatedAt), Date.now()));
    bump();
  };

  const handleResume = (session: AiSessionSummary) => {
    dismissedIds.delete(session.id);
    bump();
    onResumeSession(session);
  };

  const handleDismissAll = () => {
    const now = Date.now();
    for (const session of sessionsNeedingInput) {
      dismissedIds.set(session.id, Math.max(parseUpdatedAtMs(session.updatedAt), now));
    }
    bump();
    onDismissAll();
  };

  return (
    <section className="session-notification-banner" role="region" aria-live="polite" aria-label={t("sessionBanner.regionLabel", "AI sessions in progress, needing input, or failed")}>
      <div className="session-notification-banner__header">
        <div className="session-notification-banner__headline">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{headerText}</span>
        </div>
        <button className="session-notification-banner__dismiss-all" onClick={handleDismissAll}>
          <X size={14} aria-hidden="true" />
          <span>{t("sessionBanner.dismissAll", "Dismiss all")}</span>
        </button>
      </div>

      <div className="session-notification-banner__list">
        {sessionsNeedingInput.map((session) => {
          const Icon = TYPE_ICONS[session.type];
          const isError = session.status === "error";
          const isGenerating = session.status === "generating";
          const isObservationalCliProgress = session.type === "cli-agent" && (
            session.status === "generating" || session.status === "waiting_on_input"
          );
          const variantSpec =
            session.type === "cli-agent" && session.cliVariant
              ? CLI_VARIANT_SPEC[session.cliVariant]
              : null;

          // Pinned needs-attention variant: per-variant copy + ordered actions.
          if (variantSpec) {
            return (
              <article
                className="session-notification-banner__item session-notification-banner__item--cli session-notification-banner__item--error"
                key={session.id}
                data-session-type={session.type}
                data-session-status={session.status}
                data-cli-variant={session.cliVariant}
              >
                <div className="session-notification-banner__item-main">
                  <Icon size={16} className="session-notification-banner__type-icon" aria-hidden="true" />
                  <div className="session-notification-banner__text">
                    <p className="session-notification-banner__title" title={session.title}>{session.title}</p>
                    <p className="session-notification-banner__meta">
                      {t(variantSpec.messageKey, variantSpec.messageDefault)}
                    </p>
                  </div>
                </div>

                <div className="session-notification-banner__actions">
                  {variantSpec.actions.map((action) => {
                    const label = t(CLI_ACTION_LABELS[action].key, CLI_ACTION_LABELS[action].defaultVal);
                    const disabledReason = !onCliAction
                      ? t("sessionBanner.cli.actionUnavailable", "Action unavailable")
                      : getCliActionDisabledReason?.(session, action);
                    const disabled = Boolean(disabledReason);

                    return (
                      <button
                        key={action}
                        className={`session-notification-banner__resume${disabled ? " session-notification-banner__resume--disabled" : ""}`}
                        data-cli-action={action}
                        data-cli-action-disabled={disabled ? "true" : undefined}
                        disabled={disabled}
                        aria-label={disabled ? `${label} unavailable: ${disabledReason}` : undefined}
                        title={disabledReason ?? undefined}
                        onClick={() => {
                          if (disabled) return;
                          /*
                           * FNXC:SessionBanner 2026-06-14-19:32:
                           * Enabled CLI action buttons must call the host handler; unsupported or missing-id actions render disabled instead so no visible action can fall through to a silent no-op. Advance and cancel preserve the banner's local-dismiss contract after firing the observable host action.
                           */
                          onCliAction?.(session, action);
                          if (action === "cancel" || action === "advance") {
                            dismissLocally(session);
                            onDismissSession(session.id);
                          }
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                  <button
                    className="session-notification-banner__dismiss"
                    onClick={() => {
                      dismissLocally(session);
                      onDismissSession(session.id);
                    }}
                    aria-label={t("sessionBanner.dismissItem", "Dismiss {{title}}", { title: session.title })}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          }

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
                ) : isGenerating ? (
                  <LoaderCircle size={16} className="session-notification-banner__type-icon session-notification-banner__type-icon--progress animate-spin" aria-hidden="true" />
                ) : (
                  <Icon size={16} className="session-notification-banner__type-icon" aria-hidden="true" />
                )}
                <div className="session-notification-banner__text">
                  <p className="session-notification-banner__title" title={session.title}>{session.title}</p>
                  <p className="session-notification-banner__meta">
                    {isError
                      ? t("sessionBanner.failed", "Failed")
                      : isGenerating
                        ? t("sessionBanner.inProgress", "In progress")
                        : t(TYPE_LABEL_KEYS[session.type].key, TYPE_LABEL_KEYS[session.type].defaultVal)}
                  </p>
                </div>
              </div>

              <div className="session-notification-banner__actions">
                {/*
                 * FNXC:SessionBanner 2026-07-16-20:55:
                 * FN-8229 moves in-progress sessions from the footer pill here.
                 * CLI progress has no dashboard resume destination, so it is
                 * observational rather than exposing a silent Resume action.
                 */}
                {!isObservationalCliProgress && (
                  <button className="session-notification-banner__resume" onClick={() => handleResume(session)}>
                    {isError ? t("sessionBanner.retry", "Retry") : t("sessionBanner.resume", "Resume")}
                  </button>
                )}
                <button
                  className="session-notification-banner__dismiss"
                  onClick={() => {
                    dismissLocally(session);
                    onDismissSession(session.id);
                  }}
                  aria-label={t("sessionBanner.dismissItem", "Dismiss {{title}}", { title: session.title })}
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
