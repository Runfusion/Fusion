import type { AgentLogEntry } from "@fusion/core";
import { ProviderIcon } from "./ProviderIcon";
import { useRef, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

const markdownComponents: Components = {
  pre: ({ children, ...props }) => (
    <pre
      {...props}
      style={{
        overflowX: "auto",
        maxWidth: "100%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <table
      {...props}
      style={{
        display: "block",
        overflowX: "auto",
        maxWidth: "100%",
      }}
    >
      {children}
    </table>
  ),
};

interface ModelInfo {
  provider?: string;
  modelId?: string;
}

interface AgentLogViewerProps {
  entries: AgentLogEntry[];
  loading: boolean;
  executorModel?: ModelInfo | null;
  validatorModel?: ModelInfo | null;
  planningModel?: ModelInfo | null;
}

/**
 * Renders agent log entries in a scrollable, monospace container.
 * Displays entries in reverse chronological order (newest first).
 * Auto-scrolls to keep latest entries visible when streaming.
 * Supports toggling between markdown-formatted and plain-text rendering.
 */
export function AgentLogViewer({ entries, loading, executorModel, validatorModel, planningModel }: AgentLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousEntryCountRef = useRef<number>(0);
  const [renderMarkdown, setRenderMarkdown] = useState(true);

  // Auto-scroll to top when new entries arrive (since newest are first)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const newEntryCount = entries.length;
    const previousCount = previousEntryCountRef.current;

    // Only scroll if new entries were added and user is near the top
    if (newEntryCount > previousCount) {
      // Check if user is already near the top (within 50px)
      const isNearTop = container.scrollTop <= 50;

      if (isNearTop) {
        container.scrollTop = 0;
      }
    }

    previousEntryCountRef.current = newEntryCount;
  }, [entries]);

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

  // Reverse entries so newest appear first
  const reversedEntries = [...entries].reverse();

  const hasExecutorOverride = executorModel?.provider && executorModel?.modelId;
  const hasValidatorOverride = validatorModel?.provider && validatorModel?.modelId;
  const hasPlanningOverride = planningModel?.provider && planningModel?.modelId;

  return (
    <div
      ref={containerRef}
      className="agent-log-viewer agent-log-viewer--streaming"
      data-testid="agent-log-viewer"
      style={{
        fontFamily: "monospace",
        fontSize: "13px",
        lineHeight: "1.5",
        overflowY: "auto",
        overflowX: "hidden",
        padding: "12px",
        background: "var(--bg-secondary)",
        borderRadius: "6px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
      }}
    >
      {/* Model info header */}
      <div
        className="agent-log-model-header"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "16px",
          padding: "8px 12px",
          marginBottom: "12px",
          background: "var(--bg-tertiary)",
          borderRadius: "4px",
          fontSize: "12px",
          color: "var(--text-muted, #888)",
          overflow: "hidden",
          minWidth: 0,
          alignItems: "center",
        }}
        data-testid="agent-log-model-header"
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontWeight: 600 }}>Executor:</span>
          {hasExecutorOverride ? (
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <ProviderIcon provider={executorModel.provider!} size="sm" />
              <span style={{ color: "var(--text-secondary, #aaa)" }}>
                {executorModel.provider}/{executorModel.modelId}
              </span>
            </span>
          ) : (
            <span className="model-badge-default">Using default</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontWeight: 600 }}>Validator:</span>
          {hasValidatorOverride ? (
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <ProviderIcon provider={validatorModel.provider!} size="sm" />
              <span style={{ color: "var(--text-secondary, #aaa)" }}>
                {validatorModel.provider}/{validatorModel.modelId}
              </span>
            </span>
          ) : (
            <span className="model-badge-default">Using default</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontWeight: 600 }}>Planning/Triage:</span>
          {hasPlanningOverride ? (
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <ProviderIcon provider={planningModel.provider!} size="sm" />
              <span style={{ color: "var(--text-secondary, #aaa)" }}>
                {planningModel.provider}/{planningModel.modelId}
              </span>
            </span>
          ) : (
            <span className="model-badge-default">Using default</span>
          )}
        </div>
        {/* Markdown render toggle */}
        <div style={{ marginLeft: "auto" }}>
          <button
            className="agent-log-mode-toggle"
            onClick={() => setRenderMarkdown((prev) => !prev)}
            aria-label={renderMarkdown ? "Switch to plain text mode" : "Switch to markdown mode"}
            aria-pressed={renderMarkdown}
            data-testid="agent-log-mode-toggle"
            title={renderMarkdown ? "Show raw text" : "Show formatted markdown"}
          >
            {renderMarkdown ? "Markdown" : "Plain"}
          </button>
        </div>
      </div>
      {reversedEntries.map((entry, i) => {
        // Look at previous entry in reversed array (= next chronologically) for deduplication
        const prev = reversedEntries[i - 1];
        const isBlockLevel = entry.type === "tool" || entry.type === "tool_result" || entry.type === "tool_error";
        const showBadge = entry.agent
          ? isBlockLevel || i === 0 || (prev && (prev.agent !== entry.agent || prev.type !== entry.type))
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

        const timestampSpan = (
          <span
            className="agent-log-timestamp"
            data-testid="agent-log-timestamp"
            style={{
              color: "var(--text-muted, #888)",
              fontSize: "10px",
              marginRight: "6px",
              opacity: 0.7,
            }}
          >
            {formatTimestamp(entry.timestamp)}
          </span>
        );

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
              {agentBadge}{timestampSpan}⚡ {entry.text}
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
              {agentBadge}{timestampSpan}
              {renderMarkdown ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {entry.text}
                </ReactMarkdown>
              ) : (
                entry.text
              )}
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
              {agentBadge}{timestampSpan}✓ {entry.text}
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
              {agentBadge}{timestampSpan}✗ {entry.text}
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
            {agentBadge}{timestampSpan}
            {renderMarkdown ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {entry.text}
              </ReactMarkdown>
            ) : (
              entry.text
            )}
          </span>
        );
      })}
    </div>
  );
}
