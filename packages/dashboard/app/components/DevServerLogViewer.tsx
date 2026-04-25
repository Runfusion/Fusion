import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Loader2, Maximize2, Minimize2, Search } from "lucide-react";
import "./DevServerLogViewer.css";
import type { DevServerLogEntry } from "../hooks/useDevServerLogs";

interface DevServerLogViewerProps {
  entries: DevServerLogEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number | null;
  onLoadMore: () => void;
  /** Whether the dev server is currently running (affects auto-scroll behavior) */
  isRunning: boolean;
}

type LogSeverity = "info" | "warn" | "error";
type LogSeverityFilter = "all" | LogSeverity;

// eslint-disable-next-line no-control-regex -- ANSI escape stripping is required for readable terminal logs.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function formatTime(value: string): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getEntrySeverity(entry: DevServerLogEntry): LogSeverity {
  if (entry.stream === "stderr") {
    return "error";
  }

  const normalizedText = stripAnsi(entry.text).toLowerCase();
  if (/\b(warn|warning)\b/.test(normalizedText)) {
    return "warn";
  }

  if (/\b(error|fatal)\b/.test(normalizedText)) {
    return "error";
  }

  return "info";
}

function highlightText(value: string, search: string): ReactNode {
  if (!search) {
    return value;
  }

  const matcher = new RegExp(`(${escapeRegExp(search)})`, "ig");
  const parts = value.split(matcher);
  const normalizedSearch = search.toLowerCase();

  return (
    <>
      {parts.map((part, index) => (
        part.toLowerCase() === normalizedSearch
          ? <mark key={`${part}-${index}`}>{part}</mark>
          : <span key={`${part}-${index}`}>{part}</span>
      ))}
    </>
  );
}

export function DevServerLogViewer({
  entries,
  loading,
  loadingMore,
  hasMore,
  total,
  onLoadMore,
  isRunning,
}: DevServerLogViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const prevEntryCountRef = useRef(entries.length);
  const prevRunningRef = useRef(isRunning);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<LogSeverityFilter>("all");

  const filteredBySeverity = useMemo(() => {
    if (severityFilter === "all") {
      return entries;
    }

    return entries.filter((entry) => getEntrySeverity(entry) === severityFilter);
  }, [entries, severityFilter]);

  const filteredEntries = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return filteredBySeverity;
    }

    return filteredBySeverity.filter((entry) => stripAnsi(entry.text).toLowerCase().includes(normalizedSearch));
  }, [filteredBySeverity, searchQuery]);

  const matchCount = filteredEntries.length;

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
    setIsUserScrolling(false);
  }, []);

  useEffect(() => {
    const previousRunning = prevRunningRef.current;
    const previousEntries = prevEntryCountRef.current;
    const hasNewEntries = entries.length > previousEntries;

    if (isRunning && (!previousRunning || (!isUserScrolling && hasNewEntries))) {
      scrollToBottom();
    }

    prevRunningRef.current = isRunning;
    prevEntryCountRef.current = entries.length;
  }, [entries.length, isRunning, isUserScrolling, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const threshold = 50;
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - threshold;
    setIsUserScrolling(!atBottom);
  }, []);

  useEffect(() => {
    if (loading || entries.length === 0) {
      return;
    }

    // Keep current behavior consistent when filtering or loading more while at bottom.
    if (!isUserScrolling && isRunning) {
      scrollToBottom();
    }
  }, [entries, isRunning, isUserScrolling, loading, scrollToBottom]);

  if (loading && entries.length === 0) {
    return (
      <section className="devserver-log-viewer" data-testid="devserver-log-viewer">
        <div className="devserver-log-viewer__loading" data-testid="devserver-log-loading">
          <Loader2 size={16} className="devserver-log-viewer__spinner" />
          <span>Loading logs…</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`devserver-log-viewer${isFullscreen ? " devserver-log-viewer--fullscreen" : ""}`}
      data-testid="devserver-log-viewer"
    >
      <header className="devserver-log-viewer__toolbar">
        <div className="devserver-log-viewer__toolbar-meta">
          <span className="devserver-log-viewer__title">Logs</span>
          <span className="devserver-log-viewer__count" data-testid="devserver-log-count">
            {total !== null ? `${entries.length}/${total}` : `${entries.length}`} lines
          </span>
        </div>

        <div className="devserver-log-viewer__toolbar-actions">
          <label className="devserver-log-viewer__severity" htmlFor="devserver-log-severity-filter">
            <span className="visually-hidden">Filter logs by severity</span>
            <select
              id="devserver-log-severity-filter"
              className="select devserver-log-viewer__severity-select"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value as LogSeverityFilter)}
              data-testid="devserver-log-severity-filter"
              aria-label="Filter logs by severity"
            >
              <option value="all">All severities</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </label>

          <label className="devserver-log-viewer__search" htmlFor="devserver-log-search">
            <span className="visually-hidden">Search logs</span>
            <Search size={14} />
            <input
              id="devserver-log-search"
              className="input devserver-log-viewer__search-input"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search logs"
              data-testid="devserver-log-search-input"
              aria-label="Search logs"
            />
          </label>

          {searchQuery.trim().length > 0 && (
            <span className="devserver-log-viewer__matches" data-testid="devserver-log-match-count">
              {matchCount} match{matchCount === 1 ? "" : "es"}
            </span>
          )}

          <button
            type="button"
            className="btn btn-sm btn-icon"
            onClick={() => setIsFullscreen((prev) => !prev)}
            data-testid="devserver-log-fullscreen-toggle"
            aria-label={isFullscreen ? "Exit fullscreen logs" : "Enter fullscreen logs"}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </header>

      <div className="devserver-log-viewer__body">
        {hasMore && (
          <div className="devserver-log-viewer__load-more" data-testid="devserver-log-load-more">
            <button
              type="button"
              className="btn btn-sm touch-target"
              onClick={onLoadMore}
              disabled={loadingMore}
              data-testid="devserver-log-load-more-button"
            >
              {loadingMore ? (
                <>
                  <Loader2 size={14} className="devserver-log-viewer__spinner" />
                  Loading older logs…
                </>
              ) : (
                "Load older logs"
              )}
            </button>
          </div>
        )}

        <div
          ref={containerRef}
          className="devserver-log-viewer__content"
          onScroll={handleScroll}
          data-testid="devserver-log-content"
        >
          {!loading && filteredEntries.length === 0 && (
            <p className="devserver-log-viewer__empty" data-testid="devserver-log-empty">
              {entries.length === 0
                ? "No logs yet. Start the dev server to see output."
                : (filteredBySeverity.length === 0
                    ? "No log lines match the selected severity."
                    : "No log lines match your search.")}
            </p>
          )}

          {filteredEntries.map((entry) => {
            const plainText = stripAnsi(entry.text);
            const timestamp = formatTime(entry.timestamp);

            return (
              <div className="devserver-log-line" key={entry.id}>
                {timestamp && (
                  <span className="devserver-log-timestamp" data-testid="devserver-log-timestamp">{timestamp}</span>
                )}
                {entry.stream === "stderr" && (
                  <span className="devserver-log-stream-badge" data-testid="devserver-log-stderr-badge">ERR</span>
                )}
                <span className="devserver-log-text">{highlightText(plainText, searchQuery.trim())}</span>
              </div>
            );
          })}
        </div>

        {isUserScrolling && isRunning && (
          <button
            type="button"
            className="btn btn-sm devserver-log-viewer__new-logs-button"
            onClick={scrollToBottom}
            data-testid="devserver-log-jump-button"
          >
            <ChevronDown size={14} />
            New logs
          </button>
        )}
      </div>
    </section>
  );
}

export type { DevServerLogViewerProps };
