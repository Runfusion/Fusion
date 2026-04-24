import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchNodeSettingsSyncStatus,
  pushNodeSettings,
  pullNodeSettings,
  syncNodeAuth,
  type NodeSettingsSyncStatus,
  type NodeSettingsSyncResult,
  type NodeAuthSyncResult,
} from "../api-node";

// ── Sync State Utilities ───────────────────────────────────────────────────────

/** Derived sync state computed from raw sync status data */
export type SyncState = "synced" | "pending" | "diff" | "error" | "never-synced";

/** Computed sync status with derived state for UI consumption */
export interface ComputedNodeSyncStatus {
  syncState: SyncState;
  lastSyncAt: string | null;
  diffCount: number;
}

/**
 * Compute the derived sync state from raw NodeSettingsSyncStatus data.
 * - never-synced: lastSyncAt is null (never been synced)
 * - error: remote node is unreachable
 * - diff: there are differences between local and remote
 * - synced: no differences and lastSyncAt is set
 * - pending: lastSyncAt is set, remote is reachable, but we don't have diff data yet
 */
export function computeSyncState(status: NodeSettingsSyncStatus): ComputedNodeSyncStatus {
  const { lastSyncAt, remoteReachable, diff } = status;
  const diffCount = diff.global.length + diff.project.length;

  if (lastSyncAt === null) {
    return { syncState: "never-synced", lastSyncAt, diffCount: 0 };
  }

  if (!remoteReachable) {
    return { syncState: "error", lastSyncAt, diffCount };
  }

  if (diffCount > 0) {
    return { syncState: "diff", lastSyncAt, diffCount };
  }

  return { syncState: "synced", lastSyncAt, diffCount: 0 };
}

/**
 * Format a relative time string from an ISO timestamp.
 * Returns "Synced Xm ago", "Synced Xh ago", "Synced Xd ago", or "Never synced".
 */
export function formatRelativeTime(isoTimestamp: string | null): string {
  if (isoTimestamp === null) {
    return "Never synced";
  }

  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return "Never synced";
  }

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) {
    return "Synced just now";
  }
  if (diffMin < 60) {
    return `Synced ${diffMin}m ago`;
  }
  if (diffHr < 24) {
    return `Synced ${diffHr}h ago`;
  }
  return `Synced ${diffDay}d ago`;
}

/** Get the CSS color variable for a sync state */
export function getSyncStateColor(state: SyncState): string {
  switch (state) {
    case "synced":
      return "var(--color-success)";
    case "pending":
      return "var(--warning)";
    case "diff":
      return "var(--warning)";
    case "error":
      return "var(--color-error)";
    case "never-synced":
      return "var(--text-muted)";
  }
}

export interface UseNodeSettingsSyncResult {
  /** Per-node sync status keyed by nodeId */
  syncStatusMap: Record<string, NodeSettingsSyncStatus>;
  /** Loading state — true ONLY during initial load, false during background polling */
  loading: boolean;
  /** Per-node loading states for push/pull/auth actions */
  actionLoading: Record<string, boolean>;
  /** Error if any */
  error: string | null;
  /** Manually refresh sync status for all tracked nodes */
  refresh: () => Promise<void>;
  /** Start tracking a node for sync status polling */
  trackNode: (nodeId: string) => void;
  /** Stop tracking a node */
  untrackNode: (nodeId: string) => void;
  /** Push local settings to a remote node */
  pushSettings: (nodeId: string) => Promise<NodeSettingsSyncResult>;
  /** Pull settings from a remote node */
  pullSettings: (nodeId: string) => Promise<NodeSettingsSyncResult>;
  /** Sync auth credentials with a remote node */
  syncAuth: (nodeId: string) => Promise<NodeAuthSyncResult>;
  /** Get auth sync state for a specific node */
  getAuthSyncState: (nodeId: string) => "match" | "differs" | "not-synced" | undefined;
  /** Get per-provider auth match details for a specific node */
  getAuthProviders: (nodeId: string) => Record<string, "match" | "differs"> | undefined;
}

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Hook for managing per-node settings synchronization state.
 *
 * Automatically polls sync status for all tracked nodes every 30 seconds.
 * Stops polling when component unmounts.
 *
 * Loading behavior: `loading` is true only during the initial fetch.
 * Background polling updates do NOT set `loading` to true, so the UI
 * keeps previously loaded data visible during refreshes. This prevents
 * skeleton flicker and scroll position resets during periodic updates (FN-1734).
 */
export function useNodeSettingsSync(): UseNodeSettingsSyncResult {
  const [syncStatusMap, setSyncStatusMap] = useState<Record<string, NodeSettingsSyncStatus>>({});
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Track which nodes are being monitored
  const trackedNodesRef = useRef<Set<string>>(new Set());
  // Track if initial load is complete
  const initialLoadCompleteRef = useRef(false);
  // Abort controller for cancelling in-flight requests
  const abortRef = useRef<AbortController | null>(null);
  // Polling interval ref
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Fetch sync status for a single node and update state.
   * Does NOT set loading=true (called during polling and initial fetch).
   */
  const fetchNodeStatus = useCallback(async (nodeId: string, _isInitial: boolean): Promise<void> => {
    try {
      const status = await fetchNodeSettingsSyncStatus(nodeId);
      setSyncStatusMap((prev) => ({
        ...prev,
        [nodeId]: status,
      }));
      setError(null);
    } catch (err) {
      // Keep stale data visible during polling failures
      console.error(`Failed to fetch sync status for node ${nodeId}:`, err);
      setError(err instanceof Error ? err.message : "Failed to fetch sync status");
    }
  }, []);

  /**
   * Refresh sync status for all tracked nodes.
   * Sets loading=true only for initial fetch, not for background refreshes.
   */
  const refresh = useCallback(async () => {
    const trackedNodes = Array.from(trackedNodesRef.current);
    if (trackedNodes.length === 0) return;

    // Cancel any in-flight requests
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    const isInitial = !initialLoadCompleteRef.current;
    if (isInitial) {
      setLoading(true);
    }
    setError(null);

    try {
      // Fetch status for all tracked nodes concurrently
      const results = await Promise.allSettled(
        trackedNodes.map((nodeId) => fetchNodeStatus(nodeId, isInitial))
      );

      // Mark initial load complete
      initialLoadCompleteRef.current = true;

      // Check if any failed
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        setError("Some sync status requests failed");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to fetch sync status");
      initialLoadCompleteRef.current = true;
    } finally {
      setLoading(false);
    }
  }, [fetchNodeStatus]);

  /**
   * Start polling sync status for all tracked nodes.
   */
  const startPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    intervalRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
  }, [refresh]);

  /**
   * Stop polling.
   */
  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Initial fetch and polling setup
  useEffect(() => {
    void refresh();
    startPolling();

    return () => {
      stopPolling();
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [refresh, startPolling, stopPolling]);

  /**
   * Start tracking a node for sync status polling.
   * Immediately fetches status for the newly tracked node.
   */
  const trackNode = useCallback((nodeId: string) => {
    if (trackedNodesRef.current.has(nodeId)) return;
    trackedNodesRef.current.add(nodeId);
    void fetchNodeStatus(nodeId, !initialLoadCompleteRef.current);
  }, [fetchNodeStatus]);

  /**
   * Stop tracking a node.
   * Removes its entry from syncStatusMap and stops polling for it.
   */
  const untrackNode = useCallback((nodeId: string) => {
    trackedNodesRef.current.delete(nodeId);
    setSyncStatusMap((prev) => {
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    // If no more tracked nodes, stop polling
    if (trackedNodesRef.current.size === 0) {
      stopPolling();
    }
  }, [stopPolling]);

  /**
   * Push local settings to a remote node.
   * Sets per-node actionLoading during the call, updates syncStatusMap on completion.
   */
  const pushSettings = useCallback(async (nodeId: string): Promise<NodeSettingsSyncResult> => {
    setActionLoading((prev) => ({ ...prev, [nodeId]: true }));
    setError(null);
    try {
      const result = await pushNodeSettings(nodeId);
      // Refresh sync status after push
      void fetchNodeStatus(nodeId, false);
      if (!result.success && result.error) {
        setError(result.error);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Push settings failed";
      setError(message);
      throw err;
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }
  }, [fetchNodeStatus]);

  /**
   * Pull settings from a remote node.
   * Sets per-node actionLoading during the call, updates syncStatusMap on completion.
   */
  const pullSettings = useCallback(async (nodeId: string): Promise<NodeSettingsSyncResult> => {
    setActionLoading((prev) => ({ ...prev, [nodeId]: true }));
    setError(null);
    try {
      const result = await pullNodeSettings(nodeId);
      // Refresh sync status after pull
      void fetchNodeStatus(nodeId, false);
      if (!result.success && result.error) {
        setError(result.error);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Pull settings failed";
      setError(message);
      throw err;
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }
  }, [fetchNodeStatus]);

  /**
   * Sync auth credentials with a remote node.
   * Sets per-node actionLoading during the call.
   */
  const syncAuth = useCallback(async (nodeId: string): Promise<NodeAuthSyncResult> => {
    setActionLoading((prev) => ({ ...prev, [nodeId]: true }));
    setError(null);
    try {
      return await syncNodeAuth(nodeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Auth sync failed";
      setError(message);
      throw err;
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }
  }, []);

  /**
   * Get auth sync state for a specific node.
   */
  const getAuthSyncState = useCallback(
    (nodeId: string): "match" | "differs" | "not-synced" | undefined => {
      const status = syncStatusMap[nodeId];
      return status?.authMatch;
    },
    [syncStatusMap],
  );

  /**
   * Get per-provider auth match details for a specific node.
   */
  const getAuthProviders = useCallback(
    (nodeId: string): Record<string, "match" | "differs"> | undefined => {
      const status = syncStatusMap[nodeId];
      return status?.authDiff;
    },
    [syncStatusMap],
  );

  return {
    syncStatusMap,
    loading,
    actionLoading,
    error,
    refresh,
    trackNode,
    untrackNode,
    pushSettings,
    pullSettings,
    syncAuth,
    getAuthSyncState,
    getAuthProviders,
  };
}
