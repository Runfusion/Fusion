import type { AgentLogEntry } from "@kb/core";
import { ProviderIcon } from "./ProviderIcon";

interface ModelInfo {
  provider?: string;
  modelId?: string;
}

interface AgentLogViewerProps {
  entries: AgentLogEntry[];
  loading: boolean;
  executorModel?: ModelInfo | null;
  validatorModel?: ModelInfo | null;
}

/**
 * Renders agent log entries in a scrollable, monospace container.
 * Displays entries in reverse chronological order (newest first).
 */
export function AgentLogViewer({ entries, loading, executorModel, validatorModel }: AgentLogViewerProps) {
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

  return (
    <div
      className="agent-log-viewer"
      data-testid="agent-log-viewer"
      style={{
        fontFamily: "monospace",
        fontSize: "13px",
        lineHeight: "1.5",
        overflowY: "auto",
        maxHeight: "500px",
        padding: "12px",
        background: "var(--bg-secondary)",
        borderRadius: "6px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {/* Model info header */}
      <div
        className="agent-log-model-header"
        style={{
          display: "flex",
          gap: "16px",
          padding: "8px 12px",
          marginBottom: "12px",
          background: "var(--bg-tertiary)",
          borderRadius: "4px",
          fontSize: "12px",
          color: "var(--text-muted, #888)",
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
