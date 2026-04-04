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
    <div ref={containerRef} className="background-tasks-indicator" style={{ position: "relative" }}>
      <button
        className="background-tasks-indicator__pill"
        onClick={() => setPopoverOpen((prev) => !prev)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "2px 10px",
          borderRadius: "12px",
          border: "1px solid var(--border-color)",
          background: hasAttention ? "var(--triage)" : "var(--surface-secondary)",
          color: hasAttention ? "#fff" : "var(--text-primary)",
          cursor: "pointer",
          fontSize: "12px",
          fontWeight: 500,
          lineHeight: "20px",
          whiteSpace: "nowrap",
        }}
        title={`${total} background AI task${total !== 1 ? "s" : ""}${needsInput > 0 ? ` (${needsInput} need${needsInput !== 1 ? "" : "s"} input)` : ""}`}
      >
        {generating > 0 && (
          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
        )}
        {needsInput > 0 && generating === 0 && <HelpCircle size={12} />}
        <span>AI {total}</span>
      </button>

      {popoverOpen && (
        <div
          className="background-tasks-indicator__popover"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            minWidth: "280px",
            maxWidth: "360px",
            background: "var(--surface-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 1000,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color)", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
            Background Tasks
          </div>
          <div style={{ maxHeight: "240px", overflowY: "auto" }}>
            {sessions.map((session) => {
              const Icon = TYPE_ICONS[session.type];
              const isGenerating = session.status === "generating";
              const isAwaiting = session.status === "awaiting_input";

              return (
                <div
                  key={session.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    borderBottom: "1px solid var(--border-color)",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    onOpenSession(session);
                    setPopoverOpen(false);
                  }}
                >
                  <Icon size={14} style={{ flexShrink: 0, color: "var(--text-secondary)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {session.title}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      {TYPE_LABELS[session.type]}
                      {isGenerating && " — generating..."}
                      {isAwaiting && " — needs input"}
                    </div>
                  </div>
                  {isGenerating && <Loader2 size={14} style={{ flexShrink: 0, animation: "spin 1s linear infinite", color: "var(--color-success)" }} />}
                  {isAwaiting && <HelpCircle size={14} style={{ flexShrink: 0, color: "var(--triage)" }} />}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismissSession(session.id);
                    }}
                    style={{
                      flexShrink: 0,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px",
                      color: "var(--text-secondary)",
                      borderRadius: "4px",
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
