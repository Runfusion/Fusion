import { useState, useEffect, useCallback, useRef } from "react";
import type { DockerNodeConfig, NodeCreateInput, NodeInfo, NodeUpdateInput } from "../api";
import {
  fetchDockerConfigDiff,
  fetchDockerNodeConfig,
  fetchNodes,
  registerNode,
  updateDockerNodeConfig,
  updateNode,
  unregisterNode,
  checkNodeHealth,
} from "../api";

export interface UseNodesResult {
  nodes: NodeInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  register: (input: NodeCreateInput) => Promise<NodeInfo>;
  update: (id: string, updates: NodeUpdateInput) => Promise<NodeInfo>;
  unregister: (id: string) => Promise<void>;
  healthCheck: (id: string) => Promise<void>;
  fetchDockerConfig: (nodeId: string) => Promise<DockerNodeConfig | null>;
  patchDockerConfig: (nodeId: string, config: Partial<DockerNodeConfig>) => Promise<DockerNodeConfig>;
  fetchDockerDiff: (nodeId: string) => Promise<{ persistedVersion: number; deployedVersion: number | null; needsRecreate: boolean }>;
}

const POLL_INTERVAL_MS = 10000; // 10 seconds
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

/**
 * Hook for fetching and managing node registry state.
 * Automatically polls for updates every 10 seconds.
 * Refetches when the tab becomes visible again.
 */
export function useNodes(): UseNodesResult {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchNodes();
      setNodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch nodes");
      // Keep stale data visible if polling refresh fails
    }
  }, []);

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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch nodes");
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
        return;
      }

      lastVisibilityRefreshRef.current = now;
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (loading) return;

    intervalRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [loading, refresh]);

  const register = useCallback(async (input: NodeCreateInput): Promise<NodeInfo> => {
    const node = await registerNode(input);
    setNodes((prev) => [...prev, node]);
    return node;
  }, []);

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

  const patchDockerConfig = useCallback(async (nodeId: string, config: Partial<DockerNodeConfig>) => {
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
  };
}
