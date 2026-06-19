import type { AgentLogEntry } from "@fusion/core";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ProviderIcon } from "./ProviderIcon";
import React, { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo, useId, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Maximize2, Minimize2, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import "./AgentLogViewer.css";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

const MARKDOWN_TOGGLE_STORAGE_KEY = "fn-agent-log-markdown";
const TOOL_OUTPUT_TOGGLE_STORAGE_KEY = "fn-agent-log-tool-output";

function readBooleanPref(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeBooleanPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // ignore storage failures (quota, private mode, etc.)
  }
}

/*
FNXC:AgentLogTimestamps 2026-06-17-17:34:
FN-6601 centralizes timestamp bucket math but AgentLog keeps its existing translation keys and future timestamps continue to render as "just now".
*/
function formatTimestamp(iso: string, t: TFunction<"app">): string {
  const bucket = getRelativeTimeBucket(iso);
  if (!bucket) {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? t("agentLog.timeJustNow", "just now") : date.toLocaleDateString();
  }

  switch (bucket.bucket) {
    case "just-now":
      return t("agentLog.timeJustNow", "just now");
    case "minutes":
      return t("agentLog.timeMinutesAgo", "{{count}}m ago", { count: bucket.count });
    case "hours":
      return t("agentLog.timeHoursAgo", "{{count}}h ago", { count: bucket.count });
    case "days":
      return t("agentLog.timeDaysAgo", "{{count}}d ago", { count: bucket.count });
    case "weeks":
    case "older":
      return bucket.date.toLocaleDateString();
  }
}

export const markdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  code: ({ children, ...props }) => {
    const text = typeof children === "string" ? children : React.Children.toArray(children).join("");
    const linkedChildren = linkifyFilePaths(text);
    if (linkedChildren.length === 1 && typeof linkedChildren[0] === "string") {
      return <code {...props}>{children}</code>;
    }
    return <code {...props}>{linkedChildren}</code>;
  },
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

function getAgentDisplayName(agent: string, t: TFunction<"app">): string {
  if (agent === "triage") return t("agentLog.agentNameTriage", "Plan");
  return agent;
}

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

function isToolLikeType(type: AgentLogEntry["type"]): boolean {
  return type === "tool" || type === "tool_result" || type === "tool_error";
}

interface CollapsibleToolDetailProps {
  detail: string;
  type?: "tool" | "tool_result" | "tool_error";
}

function CollapsibleToolDetail({ detail }: CollapsibleToolDetailProps): ReactElement {
  const { t } = useTranslation("app");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const lineCount = detail.split("\n").length;
  const toggleLabel = expanded
    ? t("agentLog.hideOutput", "Hide output")
    : t("agentLog.showOutput", `Show output${lineCount > 1 ? ` (${lineCount} lines)` : ""}`);

  return (
    <div className="agent-log-tool-detail-wrapper">
      <button
        type="button"
        className="agent-log-tool-detail-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={contentId}
        data-testid="tool-detail-toggle"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{toggleLabel}</span>
      </button>
      <div
        id={contentId}
        className={expanded ? "agent-log-tool-detail-content" : "agent-log-tool-detail-content agent-log-tool-detail-content--collapsed"}
        data-testid="tool-detail-content"
      >
        <pre className="agent-log-tool-detail">{linkifyFilePaths(detail)}</pre>
      </div>
    </div>
  );
}

function shouldShowBadge(entry: AgentLogEntry, previousEntry?: AgentLogEntry): boolean {
  if (!entry.agent) return false;
  if (isToolLikeType(entry.type)) return true;
  return !previousEntry || previousEntry.agent !== entry.agent || previousEntry.type !== entry.type;
}

interface RenderEntry {
  entry: AgentLogEntry;
  hiddenToolBoundaryId: number;
}

type AgentLogRenderGroup =
  | {
    kind: "single";
    entry: AgentLogEntry;
    key: string;
    showBadge: boolean;
  }
  | {
    kind: "text" | "thinking";
    entries: AgentLogEntry[];
    key: string;
    showBadge: boolean;
  };

function buildRenderGroups(renderEntries: RenderEntry[], entryKeys: string[]): AgentLogRenderGroup[] {
  const groups: AgentLogRenderGroup[] = [];

  for (let i = 0; i < renderEntries.length; i += 1) {
    const { entry, hiddenToolBoundaryId } = renderEntries[i];
    const rowKey = entryKeys[i] ?? `${getEntrySignature(entry)}|fallback`;
    const previousRenderEntry = i > 0 ? renderEntries[i - 1] : undefined;
    const previousEntry = previousRenderEntry?.entry;
    const showBadge = shouldShowBadge(entry, previousEntry)
      || (previousRenderEntry !== undefined && previousRenderEntry.hiddenToolBoundaryId !== hiddenToolBoundaryId);

    if (entry.type === "text" || entry.type === "thinking") {
      const groupedEntries: AgentLogEntry[] = [entry];
      let j = i + 1;
      while (j < renderEntries.length) {
        const next = renderEntries[j];
        const nextEntry = next.entry;
        if (
          nextEntry.type !== entry.type
          || nextEntry.agent !== entry.agent
          || next.hiddenToolBoundaryId !== hiddenToolBoundaryId
        ) {
          break;
        }
        groupedEntries.push(nextEntry);
        j += 1;
      }

      const endKey = entryKeys[j - 1] ?? `${getEntrySignature(renderEntries[j - 1].entry)}|fallback`;
      groups.push({
        kind: entry.type,
        entries: groupedEntries,
        key: `${rowKey}->${endKey}`,
        showBadge,
      });
      i = j - 1;
      continue;
    }

    groups.push({
      kind: "single",
      entry,
      key: rowKey,
      showBadge,
    });
  }

  return groups;
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
 * - Coalesces consecutive same-agent `text`/`thinking` chunks into continuous groups
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
  const { t } = useTranslation("app");
  const containerRef = useRef<HTMLDivElement>(null);
  const previousEntryCountRef = useRef<number>(0);
  const previousScrollHeightRef = useRef<number>(0);
  const previousOldestEntryKeyRef = useRef<string | null>(null);
  const previousNewestEntryKeyRef = useRef<string | null>(null);
  const [renderMarkdown, setRenderMarkdown] = useState(() =>
    readBooleanPref(MARKDOWN_TOGGLE_STORAGE_KEY, true),
  );
  const [showToolOutput, setShowToolOutput] = useState(() =>
    readBooleanPref(TOOL_OUTPUT_TOGGLE_STORAGE_KEY, true),
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modelHeaderExpanded, setModelHeaderExpanded] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);

  useEffect(() => {
    writeBooleanPref(MARKDOWN_TOGGLE_STORAGE_KEY, renderMarkdown);
  }, [renderMarkdown]);

  useEffect(() => {
    writeBooleanPref(TOOL_OUTPUT_TOGGLE_STORAGE_KEY, showToolOutput);
  }, [showToolOutput]);

  const renderEntries = useMemo(() => {
    if (showToolOutput) {
      return entries.map((entry) => ({ entry, hiddenToolBoundaryId: 0 }));
    }

    const filtered: RenderEntry[] = [];
    let hiddenToolBoundaryId = 0;
    for (const entry of entries) {
      if (isToolLikeType(entry.type)) {
        hiddenToolBoundaryId += 1;
        continue;
      }
      filtered.push({ entry, hiddenToolBoundaryId });
    }
    return filtered;
  }, [entries, showToolOutput]);

  const visibleEntries = useMemo(
    () => renderEntries.map((renderEntry) => renderEntry.entry),
    [renderEntries],
  );

  const chronologicalEntryKeys = useMemo(
    () => buildEntryRenderKeys(visibleEntries),
    [visibleEntries],
  );

  const renderGroups = useMemo(
    () => buildRenderGroups(renderEntries, chronologicalEntryKeys),
    [renderEntries, chronologicalEntryKeys],
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

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!isFollowing) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [isFollowing]);

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
        <div className="agent-log-loading" role="status" aria-live="polite">{t("agentLog.loading", "Loading agent logs…")}</div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="agent-log-viewer" data-testid="agent-log-viewer">
        <div className="agent-log-empty">{t("agentLog.empty", "No agent output yet.")}</div>
      </div>
    );
  }

  return (
    <div
      className={`agent-log-viewer agent-log-viewer--streaming${isFullscreen ? " agent-log-viewer--fullscreen" : ""}`}
      data-testid="agent-log-viewer"
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
            aria-label={modelHeaderExpanded ? t("agentLog.collapseModelDetails", "Collapse model details") : t("agentLog.expandModelDetails", "Expand model details")}
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
            aria-label={renderMarkdown ? t("agentLog.switchPlainText", "Switch to plain text mode") : t("agentLog.switchMarkdown", "Switch to markdown mode")}
            aria-pressed={renderMarkdown}
            data-testid="agent-log-mode-toggle"
            title={renderMarkdown ? t("agentLog.showRawText", "Show raw text") : t("agentLog.showFormattedMarkdown", "Show formatted markdown")}
          >
            {renderMarkdown ? t("agentLog.markdown", "Markdown") : t("agentLog.plain", "Plain")}
          </button>
          <button
            className="agent-log-mode-toggle"
            onClick={() => setShowToolOutput((prev) => !prev)}
            aria-label={showToolOutput ? t("agentLog.hideToolOutput", "Hide tool output") : t("agentLog.showToolOutput", "Show tool output")}
            aria-pressed={showToolOutput}
            data-testid="agent-log-tool-output-toggle"
            title={showToolOutput ? t("agentLog.hideToolCallsResults", "Hide tool calls and results") : t("agentLog.showToolCallsResults", "Show tool calls and results")}
          >
            {showToolOutput ? t("agentLog.toolsOn", "Tools: On") : t("agentLog.toolsOff", "Tools: Off")}
          </button>
          <button
            className="agent-log-mode-toggle"
            onClick={() => setIsFullscreen((prev) => !prev)}
            aria-label={isFullscreen ? t("agentLog.exitFullscreen", "Exit full screen") : t("agentLog.expandFullscreen", "Expand agent log to full screen")}
            data-testid="agent-log-fullscreen-toggle"
            title={isFullscreen ? t("agentLog.exitFullscreen", "Exit full screen") : t("agentLog.expandFullscreen", "Expand agent log to full screen")}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>

        {modelHeaderExpanded && (
          <div id="agent-log-model-details" className="agent-log-model-details">
            <div className="agent-log-model-group">
              <span className="agent-log-model-label">{t("agentLog.executor", "Executor")}:</span>
              {hasExecutorOverride ? (
                <span className="agent-log-model-value">
                  <ProviderIcon provider={executorModel.provider!} size="sm" />
                  <span>{executorModel.provider}/{executorModel.modelId}</span>
                </span>
              ) : (
                <span className="model-badge-default">{t("agentLog.usingDefault", "Using default")}</span>
              )}
            </div>
            <div className="agent-log-model-group">
              <span className="agent-log-model-label">{t("agentLog.reviewer", "Reviewer")}:</span>
              {hasValidatorOverride ? (
                <span className="agent-log-model-value">
                  <ProviderIcon provider={validatorModel.provider!} size="sm" />
                  <span>{validatorModel.provider}/{validatorModel.modelId}</span>
                </span>
              ) : (
                <span className="model-badge-default">{t("agentLog.usingDefault", "Using default")}</span>
              )}
            </div>
            <div className="agent-log-model-group">
              <span className="agent-log-model-label">{t("agentLog.planning", "Planning")}:</span>
              {hasPlanningOverride ? (
                <span className="agent-log-model-value">
                  <ProviderIcon provider={planningModel.provider!} size="sm" />
                  <span>{planningModel.provider}/{planningModel.modelId}</span>
                </span>
              ) : (
                <span className="model-badge-default">{t("agentLog.usingDefault", "Using default")}</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        className="agent-log-viewer-scroll"
        onScroll={handleScroll}
      >
        {/* Pagination summary */}
        {totalCount !== null && (
          <div className="agent-log-summary" data-testid="agent-log-summary">
            {t("agentLog.showing", "Showing {{visible}} of {{total}} entries", { visible: visibleEntries.length, total: totalCount })}
            {!showToolOutput && entries.length !== visibleEntries.length
              ? ` (${t("agentLog.toolEntriesHidden", "{{count}} tool entries hidden", { count: entries.length - visibleEntries.length })})`
              : ""}
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
                  {t("agentLog.loadingMore", "Loading…")}
                </>
              ) : (
                t("agentLog.loadMore", "Load More")
              )}
            </button>
          </div>
        )}

        {renderGroups.map((group) => {
          const firstEntry = group.kind === "single" ? group.entry : group.entries[0];
          const timestampSpan = group.showBadge ? (
            <span className="agent-log-timestamp" data-testid="agent-log-timestamp">
              {formatTimestamp(firstEntry.timestamp, t as TFunction<"app">)}
            </span>
          ) : null;

          const agentBadge = group.showBadge ? (
            <span className="agent-log-badge-row">
              <span className="agent-log-agent-badge">[{getAgentDisplayName(firstEntry.agent!, t as TFunction<"app">)}]</span>
              {timestampSpan}
            </span>
          ) : null;

          if (group.kind === "single") {
            const { entry } = group;

            if (entry.type === "tool") {
              return (
                <div key={group.key} className="agent-log-tool">
                  {agentBadge}
                  <div className="agent-log-tool-title">⚡ {entry.text}</div>
                  {entry.detail ? <CollapsibleToolDetail detail={entry.detail} type="tool" /> : null}
                </div>
              );
            }

            if (entry.type === "tool_result") {
              return (
                <div key={group.key} className="agent-log-tool-result">
                  {agentBadge}
                  <div className="agent-log-tool-title">✓ {entry.text}</div>
                  {entry.detail ? <CollapsibleToolDetail detail={entry.detail} type="tool_result" /> : null}
                </div>
              );
            }

            if (entry.type === "tool_error") {
              return (
                <div key={group.key} className="agent-log-tool-error">
                  {agentBadge}
                  <div className="agent-log-tool-title">✗ {entry.text}</div>
                  {entry.detail ? <CollapsibleToolDetail detail={entry.detail} type="tool_error" /> : null}
                </div>
              );
            }
          }

          const groupedText = group.kind === "single"
            ? firstEntry.text
            : group.entries.map((entry) => entry.text).join("");

          if (group.kind === "thinking") {
            return (
              <div key={group.key} className="agent-log-thinking">
                {agentBadge}
                {renderMarkdown ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {groupedText}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <pre className="agent-log-plain-block">{linkifyFilePaths(groupedText)}</pre>
                )}
              </div>
            );
          }

          return (
            <div key={group.key} className="agent-log-text">
              {agentBadge}
              {renderMarkdown ? (
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {groupedText}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="agent-log-plain-block">{linkifyFilePaths(groupedText)}</pre>
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
            <span>{t("agentLog.live", "Live")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
