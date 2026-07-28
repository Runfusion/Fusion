import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DockerNodeConfigInfo, NodeCreateInput, NodeInfo, NodeOnboardingInput, NodeUpdateInput, RemoteNodeProjectDiscoveryResult } from "../api";
import {
  fetchDockerConfigDiff,
  fetchDockerNodeConfig,
  fetchNodes,
  registerNode,
  updateDockerNodeConfig,
  updateNode,
  unregisterNode,
  checkNodeHealth,
  discoverRemoteNodeProjects,
} from "../api";
import { persistNodeProjectPathMappings } from "../api-node";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { isVisibilityResumeError, useTabVisibilitySuspension, useVisibilityAwarePoll } from "./visibilitySuspension";

export interface UseNodesResult {
  nodes: NodeInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  register: (input: NodeOnboardingInput) => Promise<NodeInfo>;
  update: (id: string, updates: NodeUpdateInput) => Promise<NodeInfo>;
  unregister: (id: string) => Promise<void>;
  healthCheck: (id: string) => Promise<void>;
  fetchDockerConfig: (nodeId: string) => Promise<DockerNodeConfigInfo | null>;
  patchDockerConfig: (nodeId: string, config: Partial<DockerNodeConfigInfo>) => Promise<DockerNodeConfigInfo>;
  fetchDockerDiff: (nodeId: string) => Promise<{ persistedVersion: number; deployedVersion: number | null; needsRecreate: boolean }>;
  discoverRemoteProjects: (input: { url: string; apiKey?: string }) => Promise<RemoteNodeProjectDiscoveryResult>;
}

const POLL_INTERVAL_MS = 10000; // 10 seconds
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

/**
 * Hook for fetching and managing node registry state.
 * Automatically polls for updates every 10 seconds.
 * Refetches when the tab becomes visible again.
 */
export function useNodes(): UseNodesResult {
  const { t } = useTranslation("app");
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);
  const nodesRef = useRef(nodes);
  const visibilitySuspension = useTabVisibilitySuspension();

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return nodesRef.current.length > 0 && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchNodes();
      setNodes(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t("nodes.errorFetching", "Failed to fetch nodes");
      if (!shouldSuppressVisibilityResumeError(errorMessage)) {
        setError(errorMessage);
      }
      // Keep stale data visible if polling refresh fails
    }
  }, [shouldSuppressVisibilityResumeError, t]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchNodes();
        if (!cancelled) {
          setNodes(data);
          setError(null);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t("nodes.errorFetching", "Failed to fetch nodes");
        if (!cancelled && !shouldSuppressVisibilityResumeError(errorMessage)) {
          setError(errorMessage);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      const now = Date.now();
      const timeSinceLastRefresh = now - lastVisibilityRefreshRef.current;
      if (timeSinceLastRefresh < VISIBILITY_REFRESH_DEBOUNCE_MS) {
        recordResumeEvent({
          view: "useNodes",
          trigger: "visibility",
          projectId: undefined,
          replayAttempted: false,
          reason: "debounce-skipped",
          detail: { timeSinceLastRefreshMs: timeSinceLastRefresh },
        });
        return;
      }

      lastVisibilityRefreshRef.current = now;
      recordResumeEvent({
        view: "useNodes",
        trigger: "visibility",
        projectId: undefined,
        replayAttempted: false,
        reason: "debounced-refresh",
      });
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, shouldSuppressVisibilityResumeError, t]);

  /*
  FNXC:MobileTabRetention 2026-07-26-16:05:
  This 10s node-registry poll was NOT visibility-gated: the `visibilitychange` listener above only ADDS a
  refresh on the visible edge and never cleared the interval, so a backgrounded tab kept fetching the node
  list every 10 seconds. Background network work is the primary signal iOS Safari / iOS PWA / Chrome Android
  use to discard a tab, producing the white-splash reload on return.

  `refreshOnVisible: false` because the debounced, instrumented listener above already owns the visible-edge
  refresh; letting the helper refresh too would fetch twice on one edge.
  */
  useVisibilityAwarePoll(refresh, POLL_INTERVAL_MS, { enabled: !loading, refreshOnVisible: false });

  const register = useCallback(async (input: NodeOnboardingInput): Promise<NodeInfo> => {
    const { projectMappings, ...nodeInput } = input;
    const node = await registerNode(nodeInput as NodeCreateInput);

    if (projectMappings.length > 0) {
      try {
        await persistNodeProjectPathMappings(node.id, projectMappings);
      } catch (error) {
        const mappingError = error instanceof Error ? error.message : t("nodes.errorPersistMappings", "Failed to persist project mappings");
        let cleanupErrorMessage = "";
        try {
          await unregisterNode(node.id);
        } catch (cleanupError) {
          cleanupErrorMessage = cleanupError instanceof Error
            ? cleanupError.message
            : t("nodes.errorUnregisterAfterMappingFailure", "Failed to unregister node after mapping failure");
        }

        await refresh();

        if (cleanupErrorMessage) {
          throw new Error(`${mappingError}. Cleanup also failed: ${cleanupErrorMessage}`);
        }
        throw new Error(mappingError);
      }
    }

    await refresh();
    return node;
  }, [refresh, t]);

  const update = useCallback(async (id: string, updates: NodeUpdateInput): Promise<NodeInfo> => {
    const node = await updateNode(id, updates);
    setNodes((prev) => prev.map((existing) => (existing.id === id ? node : existing)));
    return node;
  }, []);

  const unregister = useCallback(async (id: string): Promise<void> => {
    await unregisterNode(id);
    setNodes((prev) => prev.filter((node) => node.id !== id));
  }, []);

  const healthCheck = useCallback(async (id: string): Promise<void> => {
    const result = await checkNodeHealth(id);
    setNodes((prev) => prev.map((node) => (
      node.id === id
        ? {
          ...node,
          status: result.status,
          updatedAt: result.checkedAt,
        }
        : node
    )));
  }, []);

  const fetchDockerConfig = useCallback((nodeId: string) => fetchDockerNodeConfig(nodeId), []);

  const patchDockerConfig = useCallback(async (nodeId: string, config: Partial<DockerNodeConfigInfo>) => {
    const updatedConfig = await updateDockerNodeConfig(nodeId, config);
    setNodes((prev) => prev.map((node) => (
      node.id === nodeId
        ? { ...node, dockerConfig: updatedConfig }
        : node
    )));
    return updatedConfig;
  }, []);

  const fetchDockerDiff = useCallback(async (nodeId: string) => {
    const diff = await fetchDockerConfigDiff(nodeId);
    if ("persistedVersion" in diff) {
      return diff;
    }
    return { persistedVersion: 0, deployedVersion: null, needsRecreate: false };
  }, []);

  const discoverRemoteProjects = useCallback(async (input: { url: string; apiKey?: string }) => {
    return discoverRemoteNodeProjects(input);
  }, []);

  return {
    nodes,
    loading,
    error,
    refresh,
    register,
    update,
    unregister,
    healthCheck,
    fetchDockerConfig,
    patchDockerConfig,
    fetchDockerDiff,
    discoverRemoteProjects,
  };
}
