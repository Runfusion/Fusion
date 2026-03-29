import { useEffect, useRef, useState } from "react";
import type { AgentLogEntry } from "@kb/core";

interface AgentLogViewerProps {
  entries: AgentLogEntry[];
  loading: boolean;
}

/**
 * Renders agent log entries in a scrollable, monospace container.
 * Auto-scrolls to the bottom as new entries arrive, but pauses
 * auto-scroll when the user scrolls up (scroll-lock).
 */
const SCROLL_THRESHOLD = 40;

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
    // Enable auto-scroll only when user is near the bottom of the container
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
    setAutoScroll(nearBottom);
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
      {entries.map((entry, i) => {
        const prev = entries[i - 1];
        const isBlockLevel = entry.type === "tool" || entry.type === "tool_result" || entry.type === "tool_error";
        const showBadge = entry.agent
          ? isBlockLevel || i === 0 || prev?.agent !== entry.agent || prev?.type !== entry.type
          : false;

        const agentBadge = showBadge ? (
          <span
            className="agent-log-agent-badge"
            style={{
              color: "var(--text-muted, #888)",
              fontSize: "11px",
              marginRight: "6px",
              fontWeight: 600,
              textTransform: "uppercase" as const,
            }}
          >
            [{entry.agent}]
          </span>
        ) : null;

        if (entry.type === "tool") {
          return (
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
              {agentBadge}⚡ {entry.text}
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
          );
        }

        if (entry.type === "thinking") {
          return (
            <span
              key={i}
              className="agent-log-thinking"
              style={{
                fontStyle: "italic",
                color: "var(--text-muted, #888)",
                opacity: 0.7,
              }}
            >
              {agentBadge}{entry.text}
            </span>
          );
        }

        if (entry.type === "tool_result") {
          return (
            <div
              key={i}
              className="agent-log-tool-result"
              style={{
                color: "var(--success, #4caf50)",
                margin: "2px 0",
                padding: "2px 6px",
                borderLeft: "3px solid var(--success, #4caf50)",
                background: "rgba(76, 175, 80, 0.06)",
                fontSize: "12px",
              }}
            >
              {agentBadge}✓ {entry.text}
              {entry.detail && (
                <span
                  className="agent-log-tool-detail"
                  style={{
                    color: "var(--text-muted, #888)",
                    marginLeft: "6px",
                  }}
                >
                  — {entry.detail}
                </span>
              )}
            </div>
          );
        }

        if (entry.type === "tool_error") {
          return (
            <div
              key={i}
              className="agent-log-tool-error"
              style={{
                color: "var(--error, #e53935)",
                margin: "2px 0",
                padding: "2px 6px",
                borderLeft: "3px solid var(--error, #e53935)",
                background: "rgba(229, 57, 53, 0.06)",
                fontSize: "12px",
              }}
            >
              {agentBadge}✗ {entry.text}
              {entry.detail && (
                <span
                  className="agent-log-tool-detail"
                  style={{
                    color: "var(--text-muted, #888)",
                    marginLeft: "6px",
                  }}
                >
                  — {entry.detail}
                </span>
              )}
            </div>
          );
        }

        // Default: text entries
        return (
          <span key={i} className="agent-log-text">
            {agentBadge}{entry.text}
          </span>
        );
      })}
    </div>
  );
}
