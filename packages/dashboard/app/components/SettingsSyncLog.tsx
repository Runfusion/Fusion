import React, { useCallback, useMemo, useState } from "react";
import { ChevronDown, Download, Upload } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncLogEntry {
  id: string;
  timestamp: string;
  direction: "push" | "pull";
  result: "success" | "conflict" | "error";
  nodeId: string;
  nodeName: string;
  details?: string;
}

interface SettingsSyncLogProps {
  /** The node ID this log is for */
  nodeId: string;
  /** Sync history entries to display — provided by parent */
  entries: SyncLogEntry[];
  /** Show loading state */
  loading?: boolean;
  /** When true, hides the node name filter (used when showing log for a single node) */
  singleNode?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Component that displays recent settings sync operations as a chronological list
 * with filtering by direction and node name.
 */
export function SettingsSyncLog({
  nodeId: _nodeId,
  entries,
  loading = false,
  singleNode = false,
}: SettingsSyncLogProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<"all" | "push" | "pull">("all");
  const [nodeFilter, setNodeFilter] = useState<string>("all");

  // Toggle expanded state
  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Extract unique node names for filter dropdown
  const uniqueNodes = useMemo(() => {
    const nodes = new Set<string>();
    for (const entry of entries) {
      nodes.add(entry.nodeName);
    }
    return Array.from(nodes).sort();
  }, [entries]);

  // Filter entries based on current filters
  const filteredEntries = useMemo(() => {
    let result = [...entries];

    // Filter by direction
    if (directionFilter !== "all") {
      result = result.filter((entry) => entry.direction === directionFilter);
    }

    // Filter by node name
    if (!singleNode && nodeFilter !== "all") {
      result = result.filter((entry) => entry.nodeName === nodeFilter);
    }

    // Sort by timestamp descending (newest first)
    result.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeB - timeA;
    });

    return result;
  }, [entries, directionFilter, nodeFilter, singleNode]);

  // Format timestamp for display
  const formatTimestamp = useCallback((isoTimestamp: string): string => {
    const date = new Date(isoTimestamp);
    return date.toLocaleString();
  }, []);

  // Get result badge class
  const getResultBadgeClass = useCallback((result: SyncLogEntry["result"]): string => {
    switch (result) {
      case "success":
        return "settings-sync-log__badge--success";
      case "conflict":
        return "settings-sync-log__badge--conflict";
      case "error":
        return "settings-sync-log__badge--error";
      default:
        return "";
    }
  }, []);

  // Get result display text
  const getResultText = useCallback((result: SyncLogEntry["result"]): string => {
    switch (result) {
      case "success":
        return "Success";
      case "conflict":
        return "Conflict";
      case "error":
        return "Error";
      default:
        return result;
    }
  }, []);

  return (
    <div className="settings-sync-log">
      <div
        className="settings-sync-log__header"
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        data-testid="settings-sync-log-header"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <ChevronDown
          size={16}
          style={{
            transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s ease",
          }}
        />
        <span>
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {isExpanded && (
        <>
          <div className="settings-sync-log__filters">
            <label>
              Direction:
              <select
                value={directionFilter}
                onChange={(e) => setDirectionFilter(e.target.value as "all" | "push" | "pull")}
              >
                <option value="all">All</option>
                <option value="push">Push</option>
                <option value="pull">Pull</option>
              </select>
            </label>

            {!singleNode && (
              <label>
                Node:
                <select
                  value={nodeFilter}
                  onChange={(e) => setNodeFilter(e.target.value)}
                >
                  <option value="all">All Nodes</option>
                  {uniqueNodes.map((nodeName) => (
                    <option key={nodeName} value={nodeName}>
                      {nodeName}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {loading && entries.length === 0 ? (
            <div className="settings-sync-log__empty">Loading...</div>
          ) : filteredEntries.length === 0 ? (
            <div className="settings-sync-log__empty">No sync history available</div>
          ) : (
            <div className="settings-sync-log__list">
              {filteredEntries.map((entry) => (
                <div key={entry.id} className="settings-sync-log__entry">
                  <span className="settings-sync-log__entry-timestamp">
                    {formatTimestamp(entry.timestamp)}
                  </span>

                  <span className="settings-sync-log__entry-direction">
                    {entry.direction === "push" ? (
                      <Upload size={14} data-testid="upload-icon" />
                    ) : (
                      <Download size={14} data-testid="download-icon" />
                    )}
                  </span>

                  <span
                    className={`settings-sync-log__entry-result ${getResultBadgeClass(entry.result)}`}
                  >
                    {getResultText(entry.result)}
                  </span>

                  {!singleNode && (
                    <span className="settings-sync-log__entry-node">{entry.nodeName}</span>
                  )}

                  {entry.details && (
                    <span className="settings-sync-log__entry-details" title={entry.details}>
                      {entry.details}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
