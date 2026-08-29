/**
 * useRemoteNodeData hook - fetches projects, tasks, and health data from a remote node.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import type { ProjectInfo } from "../api";
import {
  fetchRemoteNodeHealth,
  fetchRemoteNodeProjects,
  fetchRemoteNodeTasks,
  fetchRemoteNodeProjectHealth,
  type RemoteNodeHealth,
} from "../api-node";

export interface UseRemoteNodeDataOptions {
  /** Project ID to fetch tasks for */
  projectId?: string;
  /** Search query to filter tasks */
  searchQuery?: string;
}

export interface UseRemoteNodeDataResult {
  /** Projects from the remote node */
  projects: ProjectInfo[];
  /** Tasks from the remote node (if projectId is provided) */
  tasks: Task[];
  /** Health information from the remote node */
  health: RemoteNodeHealth | null;
  /** Whether data is currently being fetched */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Manually refresh all data */
  refresh: () => void;
}

/**
 * Hook for fetching data from a remote node.
 * Fetches health and projects on mount (and when nodeId changes).
 * If projectId is provided, also fetches tasks and project health.
 */
export function useRemoteNodeData(
  nodeId: string | null,
  options?: UseRemoteNodeDataOptions,
): UseRemoteNodeDataResult {
  const { projectId, searchQuery } = options ?? {};

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [health, setHealth] = useState<RemoteNodeHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track in-flight requests for cleanup
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    // No nodeId means no fetching needed
    if (!nodeId) {
      setProjects([]);
      setTasks([]);
      setHealth(null);
      setLoading(false);
      setError(null);
      return;
    }

    // Cancel any in-flight requests
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setLoading(true);
    setError(null);

    try {
      // Fetch health and projects in parallel
      const promises: Promise<unknown>[] = [
        fetchRemoteNodeHealth(nodeId),
        fetchRemoteNodeProjects(nodeId),
      ];

      // Add tasks and project health fetches if projectId is provided
      if (projectId) {
        promises.push(fetchRemoteNodeTasks(nodeId, projectId, searchQuery));
        promises.push(fetchRemoteNodeProjectHealth(nodeId, projectId));
      }

      const results = await Promise.allSettled(promises);

      // Check if aborted
      if (abortController.signal.aborted) {
        return;
      }

      // Process results - type-safe access
      const healthResult = results[0];
      const projectsResult = results[1];

      if (healthResult.status === "rejected") {
        setError(`Failed to fetch node health: ${healthResult.reason}`);
        setLoading(false);
        return;
      }
      setHealth(healthResult.value as RemoteNodeHealth);

      if (projectsResult.status === "rejected") {
        setError(`Failed to fetch projects: ${projectsResult.reason}`);
        setLoading(false);
        return;
      }
      setProjects(projectsResult.value as ProjectInfo[]);

      // Process optional results - tasks are at index 2
      if (projectId && results[2]) {
        const tasksResult = results[2];
        if (tasksResult.status === "rejected") {
          setError(`Failed to fetch tasks: ${tasksResult.reason}`);
          setLoading(false);
          return;
        }
        if (tasksResult.status === "fulfilled") {
          setTasks(tasksResult.value as Task[]);
        }
      }

      setLoading(false);
    } catch (err) {
      if (!abortController.signal.aborted) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    }
  }, [nodeId, projectId, searchQuery]);

  // Fetch on mount and when nodeId changes
  useEffect(() => {
    void fetchData();

    // Cleanup: abort in-flight requests on unmount or when dependencies change
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [fetchData]);

  // Refresh function for manual re-fetch
  const refresh = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  return {
    projects,
    tasks,
    health,
    loading,
    error,
    refresh,
  };
}
