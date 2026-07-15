import "./BackgroundTasksIndicator.css";
import { useState, useRef, useEffect, useMemo } from "react";
import { Lightbulb, Layers, Target, Terminal, Loader2, HelpCircle, X, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiSessionSummary } from "../api";

interface BackgroundTasksIndicatorProps {
  sessions: AiSessionSummary[];
  generating: number;
  needsInput: number;
  onOpenSession: (session: AiSessionSummary) => void;
  onDismissSession: (id: string) => void;
}

const TYPE_ICONS = {
  planning: Lightbulb,
  subtask: Layers,
  mission_interview: Target,
  milestone_interview: Target,
  slice_interview: Target,
  "cli-agent": Terminal,
} as const;

export function BackgroundTasksIndicator({
  sessions,
  generating,
  needsInput,
  onOpenSession,
  onDismissSession,
}: BackgroundTasksIndicatorProps) {
  const { t } = useTranslation("app");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const previousSessionSignatureRef = useRef<Map<string, string>>(new Map());
  const clearUpdatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  // Type labels that are translatable
  const TYPE_LABELS = useMemo(
    () => ({
      planning: t("backgroundTasks.typeLabel.planning", "Planning"),
      subtask: t("backgroundTasks.typeLabel.subtask", "Subtask Breakdown"),
      mission_interview: t("backgroundTasks.typeLabel.missionInterview", "Mission Interview"),
      milestone_interview: t("backgroundTasks.typeLabel.milestoneInterview", "Milestone Interview"),
      slice_interview: t("backgroundTasks.typeLabel.sliceInterview", "Slice Interview"),
      "cli-agent": t("backgroundTasks.typeLabel.cliAgent", "CLI Agent"),
    }),
    [t],
  );

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverOpen]);

  /*
  FNXC:PlanningMultiTab 2026-07-14-00:00:
  No tab-ownership concept remains: AI interview sessions are multi-tab, so every session opens
  directly with no "active in another tab" gate, confirm prompt, or lock badge. Item animation
  keys off server-derived status/timestamp only.
  */
  // Animate per-item changes when session status/timestamp changes.
  useEffect(() => {
    const changed = new Set<string>();
    const nextSignature = new Map<string, string>();

    for (const session of sessions) {
      const signature = [session.status, session.updatedAt].join("|");

      const previous = previousSessionSignatureRef.current.get(session.id);
      if (previous && previous !== signature) {
        changed.add(session.id);
      }

      nextSignature.set(session.id, signature);
    }

    previousSessionSignatureRef.current = nextSignature;

    if (changed.size === 0) {
      return;
    }

    setRecentlyUpdated(changed);

    if (clearUpdatedTimerRef.current) {
      clearTimeout(clearUpdatedTimerRef.current);
    }

    clearUpdatedTimerRef.current = setTimeout(() => {
      setRecentlyUpdated(new Set());
      clearUpdatedTimerRef.current = null;
    }, 500);

    return () => {
      if (clearUpdatedTimerRef.current) {
        clearTimeout(clearUpdatedTimerRef.current);
        clearUpdatedTimerRef.current = null;
      }
    };
  }, [sessions]);

  if (sessions.length === 0) return null;

  const total = sessions.length;
  const hasAttention = needsInput > 0;

  return (
    <div ref={containerRef} className="background-tasks-indicator">
      <button
        className={`background-tasks-indicator__pill${hasAttention ? " background-tasks-indicator__pill--attention" : ""}`}
        onClick={() => setPopoverOpen((prev) => !prev)}
        title={
          needsInput > 0
            ? t("backgroundTasks.pillTitleWithInput", "{{count}} background AI task ({{needsInput}} needs input)", { count: total, needsInput })
            : t("backgroundTasks.pillTitle", "{{count}} background AI task", { count: total })
        }
      >
        {generating > 0 && (
          <Loader2 size={12} className="animate-spin" />
        )}
        {needsInput > 0 && generating === 0 && <HelpCircle size={12} />}
        <span>{t("backgroundTasks.pillLabel", "AI {{count}}", { count: total })}</span>
      </button>

      {popoverOpen && (
        <div className="background-tasks-indicator__popover">
          <div className="background-tasks-indicator__popover-header">
            {t("backgroundTasks.popoverHeader", "Background Tasks")}
          </div>
          <div className="background-tasks-indicator__popover-list">
            {sessions.map((session) => {
              const Icon = TYPE_ICONS[session.type];
              const isGenerating = session.status === "generating";
              const isAwaiting = session.status === "awaiting_input";
              const isError = session.status === "error";
              const isUpdated = recentlyUpdated.has(session.id);

              return (
                <div
                  key={session.id}
                  className={`background-tasks-indicator__item${isUpdated ? " background-tasks-indicator__item--updated" : ""}`}
                  style={{
                    transition: "background-color 220ms ease, transform 220ms ease",
                    backgroundColor: isUpdated
                      ? "var(--color-accent-soft, rgba(59, 130, 246, 0.14))"
                      : undefined,
                    transform: isUpdated ? "translateY(-1px)" : undefined,
                  }}
                  onClick={() => {
                    onOpenSession(session);
                    setPopoverOpen(false);
                  }}
                >
                  {isError ? (
                    <AlertCircle size={14} className="background-tasks-indicator__session-icon" style={{ color: "var(--color-error)" }} />
                  ) : (
                    <Icon size={14} className="background-tasks-indicator__session-icon" />
                  )}
                  <div className="background-tasks-indicator__session-content">
                    <div className="background-tasks-indicator__session-title">
                      {session.title}
                    </div>
                    <div className="background-tasks-indicator__session-meta">
                      {isError ? t("backgroundTasks.status.failed", "Failed") : TYPE_LABELS[session.type]}
                      {isGenerating && ` — ${t("backgroundTasks.status.generating", "generating...")}`}
                      {isAwaiting && ` — ${t("backgroundTasks.status.needsInput", "needs input")}`}
                    </div>
                  </div>
                  {isGenerating && (
                    <Loader2
                      size={14}
                      className="background-tasks-indicator__session-icon animate-spin"
                      style={{ color: "var(--color-success)" }}
                    />
                  )}
                  {isAwaiting && (
                    <HelpCircle
                      size={14}
                      className="background-tasks-indicator__session-icon"
                      style={{ color: "var(--triage)" }}
                    />
                  )}
                  <button
                    className="background-tasks-indicator__item-dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismissSession(session.id);
                    }}
                    title={t("backgroundTasks.dismissButton", "Dismiss")}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
