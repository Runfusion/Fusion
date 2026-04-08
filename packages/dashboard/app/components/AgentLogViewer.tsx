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
    >
      {/* Model info header */}
      <div className="agent-log-model-header" data-testid="agent-log-model-header">
        <div className="agent-log-model-group">
          <span className="agent-log-model-label">Executor:</span>
          {hasExecutorOverride ? (
            <span className="agent-log-model-value">
              <ProviderIcon provider={executorModel.provider!} size="sm" />
              <span>{executorModel.provider}/{executorModel.modelId}</span>
            </span>
          ) : (
            <span className="model-badge-default">Using default</span>
          )}
        </div>
        <div className="agent-log-model-group">
          <span className="agent-log-model-label">Validator:</span>
          {hasValidatorOverride ? (
            <span className="agent-log-model-value">
              <ProviderIcon provider={validatorModel.provider!} size="sm" />
              <span>{validatorModel.provider}/{validatorModel.modelId}</span>
            </span>
          ) : (
            <span className="model-badge-default">Using default</span>
          )}
        </div>
        <div className="agent-log-model-group">
          <span className="agent-log-model-label">Planning/Triage:</span>
          {hasPlanningOverride ? (
            <span className="agent-log-model-value">
              <ProviderIcon provider={planningModel.provider!} size="sm" />
              <span>{planningModel.provider}/{planningModel.modelId}</span>
            </span>
          ) : (
            <span className="model-badge-default">Using default</span>
          )}
        </div>
        {/* Markdown render toggle */}
        <div className="agent-log-model-header-toggle">
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

        const timestampSpan = showBadge ? (
          <span className="agent-log-timestamp" data-testid="agent-log-timestamp">
            {formatTimestamp(entry.timestamp)}
          </span>
        ) : null;

        const agentBadge = showBadge ? (
          <span className="agent-log-badge-row">
            <span className="agent-log-agent-badge">[{entry.agent}]</span>
            {timestampSpan}
          </span>
        ) : null;

        if (entry.type === "tool") {
          return (
            <div key={i} className="agent-log-tool">
              {agentBadge}⚡ {entry.text}
              {entry.detail && <span className="agent-log-tool-detail">— {entry.detail}</span>}
            </div>
          );
        }

        if (entry.type === "thinking") {
          return (
            <span key={i} className="agent-log-thinking">
              {agentBadge}
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
            <div key={i} className="agent-log-tool-result">
              {agentBadge}✓ {entry.text}
              {entry.detail && <span className="agent-log-tool-detail">— {entry.detail}</span>}
            </div>
          );
        }

        if (entry.type === "tool_error") {
          return (
            <div key={i} className="agent-log-tool-error">
              {agentBadge}✗ {entry.text}
              {entry.detail && <span className="agent-log-tool-detail">— {entry.detail}</span>}
            </div>
          );
        }

        // Default: text entries
        return (
          <span key={i} className="agent-log-text">
            {agentBadge}
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
