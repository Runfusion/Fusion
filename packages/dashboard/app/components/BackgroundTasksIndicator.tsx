import { useState, useRef, useEffect } from "react";
import { Lightbulb, Layers, Target, Loader2, HelpCircle, X } from "lucide-react";
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
} as const;

const TYPE_LABELS = {
  planning: "Planning",
  subtask: "Subtask Breakdown",
  mission_interview: "Mission Interview",
} as const;

export function BackgroundTasksIndicator({
  sessions,
  generating,
  needsInput,
  onOpenSession,
  onDismissSession,
}: BackgroundTasksIndicatorProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  if (sessions.length === 0) return null;

  const total = sessions.length;
  const hasAttention = needsInput > 0;

  return (
    <div ref={containerRef} className="background-tasks-indicator">
      <button
        className={`background-tasks-indicator__pill${hasAttention ? " background-tasks-indicator__pill--attention" : ""}`}
        onClick={() => setPopoverOpen((prev) => !prev)}
        title={`${total} background AI task${total !== 1 ? "s" : ""}${needsInput > 0 ? ` (${needsInput} need${needsInput !== 1 ? "" : "s"} input)` : ""}`}
      >
        {generating > 0 && (
          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
        )}
        {needsInput > 0 && generating === 0 && <HelpCircle size={12} />}
        <span>AI {total}</span>
      </button>

      {popoverOpen && (
        <div className="background-tasks-indicator__popover">
          <div className="background-tasks-indicator__popover-header">
            Background Tasks
          </div>
          <div className="background-tasks-indicator__popover-list">
            {sessions.map((session) => {
              const Icon = TYPE_ICONS[session.type];
              const isGenerating = session.status === "generating";
              const isAwaiting = session.status === "awaiting_input";

              return (
                <div
                  key={session.id}
                  className="background-tasks-indicator__item"
                  onClick={() => {
                    onOpenSession(session);
                    setPopoverOpen(false);
                  }}
                >
                  <Icon size={14} className="background-tasks-indicator__session-icon" />
                  <div className="background-tasks-indicator__session-content">
                    <div className="background-tasks-indicator__session-title">
                      {session.title}
                    </div>
                    <div className="background-tasks-indicator__session-meta">
                      {TYPE_LABELS[session.type]}
                      {isGenerating && " — generating..."}
                      {isAwaiting && " — needs input"}
                    </div>
                  </div>
                  {isGenerating && (
                    <Loader2
                      size={14}
                      className="background-tasks-indicator__session-icon"
                      style={{
                        animation: "spin 1s linear infinite",
                        color: "var(--color-success)",
                      }}
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
                    title="Dismiss"
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
