import type { AgentLogEntry } from "@fusion/core";
import { ProviderIcon } from "./ProviderIcon";
import { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Maximize2, Minimize2, Loader2, ChevronDown, ChevronRight } from "lucide-react";

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

const BOTTOM_FOLLOW_THRESHOLD_PX = 50;

function isNearBottom(container: HTMLDivElement): boolean {
  return container.scrollHeight - (container.scrollTop + container.clientHeight) <= BOTTOM_FOLLOW_THRESHOLD_PX;
}

function getEntrySignature(entry: AgentLogEntry): string {
  return [
    entry.taskId,
    entry.timestamp,
    entry.agent ?? "",
    entry.type,
    entry.text,
    entry.detail ?? "",
  ].join("|");
}

function buildEntryRenderKeys(entries: AgentLogEntry[]): string[] {
  const countsBySignature = new Map<string, number>();
  return entries.map((entry) => {
    const signature = getEntrySignature(entry);
    const occurrence = countsBySignature.get(signature) ?? 0;
    countsBySignature.set(signature, occurrence + 1);
    return `${signature}|${occurrence}`;
  });
}

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
  /** Whether more entries exist beyond what's currently loaded */
  hasMore?: boolean;
  /** Callback to load older entries */
  onLoadMore?: () => void;
  /** Whether a load more request is in progress */
  loadingMore?: boolean;
  /** Total number of entries (when known) for "Showing X of Y" summary */
  totalCount?: number | null;
}

/**
 * Renders agent log entries in a scrollable, monospace container.
 *
 * Features:
 * - Displays entries in chronological order (oldest first, newest last)
 * - Auto-scrolls to keep latest entries visible when streaming
 * - Supports toggling between markdown-formatted and plain-text rendering
 * - "Load More" button to fetch older entries when pagination is enabled
 * - Shows "Showing X of Y entries" summary when totalCount is provided
 *
 * @param entries - Array of log entries (in chronological order, oldest first)
 * @param loading - Whether initial load is in progress
 * @param hasMore - Whether more older entries exist beyond the current page
 * @param onLoadMore - Callback to load older entries
 * @param loadingMore - Whether a load more request is in progress
 * @param totalCount - Total number of entries (when known) for summary display
 */
export function AgentLogViewer({
  entries,
  loading,
  executorModel,
  validatorModel,
  planningModel,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  totalCount = null,
}: AgentLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousEntryCountRef = useRef<number>(0);
  const previousScrollHeightRef = useRef<number>(0);
  const previousOldestEntryKeyRef = useRef<string | null>(null);
  const previousNewestEntryKeyRef = useRef<string | null>(null);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modelHeaderExpanded, setModelHeaderExpanded] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);

  const chronologicalEntryKeys = useMemo(
    () => buildEntryRenderKeys(entries),
    [entries],
  );

  // Keep live-follow pinned to the bottom when new streamed entries append.
  // When older history is prepended (load more), preserve viewport position.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const newEntryCount = entries.length;
    const previousCount = previousEntryCountRef.current;
    const previousScrollHeight = previousScrollHeightRef.current || container.scrollHeight;
    const oldestEntryKey = chronologicalEntryKeys[0] ?? null;
    const newestEntryKey = chronologicalEntryKeys[chronologicalEntryKeys.length - 1] ?? null;
    const oldestEntryChanged = previousOldestEntryKeyRef.current !== oldestEntryKey;
    const newestEntryChanged = previousNewestEntryKeyRef.current !== newestEntryKey;

    if (newEntryCount > previousCount) {
      if (previousCount === 0) {
        container.scrollTop = container.scrollHeight;
      } else {
        const wasNearBottom =
          previousScrollHeight - (container.scrollTop + container.clientHeight) <=
          BOTTOM_FOLLOW_THRESHOLD_PX;
        const appendedLiveEntry = newestEntryChanged && !oldestEntryChanged;
        const prependedOlderEntries = oldestEntryChanged && !newestEntryChanged;

        if (appendedLiveEntry && wasNearBottom) {
          container.scrollTop = container.scrollHeight;
        }

        if (prependedOlderEntries) {
          const heightDelta = container.scrollHeight - previousScrollHeight;
          if (heightDelta > 0) {
            container.scrollTop += heightDelta;
          }
        }
      }
    }

    previousEntryCountRef.current = newEntryCount;
    previousScrollHeightRef.current = container.scrollHeight;
    previousOldestEntryKeyRef.current = oldestEntryKey;
    previousNewestEntryKeyRef.current = newestEntryKey;
    setIsFollowing(isNearBottom(container));
  }, [entries, chronologicalEntryKeys]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setIsFollowing(isNearBottom(container));
  }, []);

  const scrollToLive = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    setIsFollowing(true);
  }, []);

  // Escape key handler to exit fullscreen mode
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape" && isFullscreen) {
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

  useEffect(() => {
    if (isFullscreen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [isFullscreen, handleKeyDown]);

  const hasExecutorOverride = executorModel?.provider && executorModel?.modelId;
  const hasValidatorOverride = validatorModel?.provider && validatorModel?.modelId;
  const hasPlanningOverride = planningModel?.provider && planningModel?.modelId;

  const modelProviders = useMemo(() => {
    const providers: Array<{ role: string; provider: string; modelId?: string }> = [];
    if (hasExecutorOverride) {
      providers.push({
        role: "Executor",
        provider: executorModel!.provider!,
        modelId: executorModel!.modelId,
      });
    }
    if (hasValidatorOverride) {
      providers.push({
        role: "Reviewer",
        provider: validatorModel!.provider!,
        modelId: validatorModel!.modelId,
      });
    }
    if (hasPlanningOverride) {
      providers.push({
        role: "Planning",
        provider: planningModel!.provider!,
        modelId: planningModel!.modelId,
      });
    }
    return providers;
  }, [
    hasExecutorOverride,
    executorModel,
    hasValidatorOverride,
    validatorModel,
    hasPlanningOverride,
    planningModel,
  ]);

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
      ref={containerRef}
      className={`agent-log-viewer agent-log-viewer--streaming${isFullscreen ? " agent-log-viewer--fullscreen" : ""}`}
      data-testid="agent-log-viewer"
      onScroll={handleScroll}
    >
      {/* Model info header */}
      <div className="agent-log-model-header" data-testid="agent-log-model-header">
        <div className="agent-log-model-icons">
          {modelProviders.map((modelProvider) => (
            <ProviderIcon
              key={`${modelProvider.role}-${modelProvider.provider}-${modelProvider.modelId ?? "default"}`}
              provider={modelProvider.provider}
              size="sm"
            />
          ))}
          <button
            className="agent-log-model-expand-btn"
            onClick={() => setModelHeaderExpanded((prev) => !prev)}
            aria-label={modelHeaderExpanded ? "Collapse model details" : "Expand model details"}
            aria-expanded={modelHeaderExpanded}
            aria-controls="agent-log-model-details"
            data-testid="agent-log-model-expand"
          >
            {modelHeaderExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
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
          <button
            className="agent-log-mode-toggle"
            onClick={() => setIsFullscreen((prev) => !prev)}
            aria-label={isFullscreen ? "Exit full screen" : "Expand agent log to full screen"}
            data-testid="agent-log-fullscreen-toggle"
            title={isFullscreen ? "Exit full screen" : "Expand agent log to full screen"}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>

        {modelHeaderExpanded && (
          <div id="agent-log-model-details" className="agent-log-model-details">
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
              <span className="agent-log-model-label">Reviewer:</span>
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
          </div>
        )}
      </div>

      {/* Pagination summary */}
      {totalCount !== null && (
        <div className="agent-log-summary" data-testid="agent-log-summary">
          Showing {entries.length} of {totalCount} entries
        </div>
      )}

      {hasMore && onLoadMore && (
        <div className="agent-log-load-more" data-testid="agent-log-load-more">
          <button
            className="agent-log-mode-toggle"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="agent-log-load-more-button"
          >
            {loadingMore ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Loading…
              </>
            ) : (
              "Load More"
            )}
          </button>
        </div>
      )}

      {entries.map((entry, i) => {
        const rowKey = chronologicalEntryKeys[i] ?? `${getEntrySignature(entry)}|fallback`;
        const prev = entries[i - 1];
        const isBlockLevel = entry.type === "tool" || entry.type === "tool_result" || entry.type === "tool_error";
        const showBadge = entry.agent
          ? isBlockLevel || !prev || prev.agent !== entry.agent || prev.type !== entry.type
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
            <div key={rowKey} className="agent-log-tool">
              {agentBadge}⚡ {entry.text}
              {entry.detail && <span className="agent-log-tool-detail">— {entry.detail}</span>}
            </div>
          );
        }

        if (entry.type === "thinking") {
          return (
            <div key={rowKey} className="agent-log-thinking">
              {agentBadge}
              {renderMarkdown ? (
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {entry.text}
                  </ReactMarkdown>
                </div>
              ) : (
                entry.text
              )}
            </div>
          );
        }

        if (entry.type === "tool_result") {
          return (
            <div key={rowKey} className="agent-log-tool-result">
              {agentBadge}✓ {entry.text}
              {entry.detail && <span className="agent-log-tool-detail">— {entry.detail}</span>}
            </div>
          );
        }

        if (entry.type === "tool_error") {
          return (
            <div key={rowKey} className="agent-log-tool-error">
              {agentBadge}✗ {entry.text}
              {entry.detail && <span className="agent-log-tool-detail">— {entry.detail}</span>}
            </div>
          );
        }

        // Default: text entries
        return (
          <div key={rowKey} className="agent-log-text">
            {agentBadge}
            {renderMarkdown ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {entry.text}
                </ReactMarkdown>
              </div>
            ) : (
              entry.text
            )}
          </div>
        );
      })}

      {!isFollowing && (
        <button
          type="button"
          className="agent-log-return-to-live"
          onClick={scrollToLive}
          data-testid="agent-log-return-to-live"
        >
          <ChevronDown size={12} />
          <span>Live</span>
        </button>
      )}
    </div>
  );
}
