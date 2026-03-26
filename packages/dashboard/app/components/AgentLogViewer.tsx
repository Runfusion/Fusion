import { useEffect, useRef, useState } from "react";
import type { AgentLogEntry } from "@hai/core";

interface AgentLogViewerProps {
  entries: AgentLogEntry[];
  loading: boolean;
}

/**
 * Renders agent log entries in a scrollable, monospace container.
 * Auto-scrolls to the bottom as new entries arrive, but pauses
 * auto-scroll when the user scrolls up (scroll-lock).
 */
export function AgentLogViewer({ entries, loading }: AgentLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new entries arrive (if scroll-lock is not active)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    // If the user is within 50px of the bottom, re-enable auto-scroll
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setAutoScroll(atBottom);
  };

  if (loading && entries.length === 0) {
    return (
      <div className="agent-log-viewer" data-testid="agent-log-viewer">
        <div className="agent-log-loading">Loading agent logs…</div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="agent-log-viewer" data-testid="agent-log-viewer">
        <div className="agent-log-empty">No agent output yet.</div>
      </div>
    );
  }

  return (
    <div
      className="agent-log-viewer"
      data-testid="agent-log-viewer"
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        fontFamily: "monospace",
        fontSize: "13px",
        lineHeight: "1.5",
        overflowY: "auto",
        maxHeight: "500px",
        padding: "12px",
        background: "var(--bg-secondary, #1a1a2e)",
        borderRadius: "6px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {entries.map((entry, i) =>
        entry.type === "tool" ? (
          <div
            key={i}
            className="agent-log-tool"
            style={{
              color: "var(--accent, #7c5cbf)",
              margin: "4px 0",
              padding: "2px 6px",
              borderLeft: "3px solid var(--accent, #7c5cbf)",
              background: "rgba(124, 92, 191, 0.08)",
            }}
          >
            ⚡ {entry.text}
            {entry.detail && (
              <span
                className="agent-log-tool-detail"
                style={{
                  color: "var(--text-muted, #888)",
                  fontSize: "12px",
                  marginLeft: "6px",
                }}
              >
                — {entry.detail}
              </span>
            )}
          </div>
        ) : (
          <span key={i} className="agent-log-text">
            {entry.text}
          </span>
        ),
      )}
    </div>
  );
}
