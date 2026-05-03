import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchRunStatus } from "@fusion/core";
import {
  attachResearchRunToTask,
  cancelResearchRun,
  createResearchRun,
  createTaskFromResearchRun,
  exportResearchRun,
  getResearchRun,
  listResearchRuns,
  retryResearchRun,
  type CreateResearchRunInput,
} from "../api";
import { subscribeSse } from "../sse-bus";
import type { ResearchAvailability, ResearchRunDetail, ResearchRunListItem } from "../research-types";

const SEARCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 4000;

export function useResearch(options?: { projectId?: string }) {
  const projectId = options?.projectId;
  const [runs, setRuns] = useState<ResearchRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ResearchRunDetail | null>(null);
  const [availability, setAvailability] = useState<ResearchAvailability>({ available: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const fetchVersionRef = useRef(0);
  const projectContextVersionRef = useRef(0);
  const previousProjectIdRef = useRef<string | undefined>(projectId);

  useEffect(() => {
    if (previousProjectIdRef.current !== projectId) {
      previousProjectIdRef.current = projectId;
      projectContextVersionRef.current++;
    }
  }, [projectId]);

  const refreshRuns = useCallback(async (query = searchQuery) => {
    const requestVersion = ++fetchVersionRef.current;
    const requestProjectId = projectId;

    setError(null);

    try {
      const response = await listResearchRuns({ q: query || undefined, limit: 100 }, requestProjectId);
      if (requestVersion !== fetchVersionRef.current || requestProjectId !== projectId) return;
      setRuns(response.runs);
      setAvailability(response.availability);
      if (selectedRunId && !response.runs.some((run) => run.id === selectedRunId)) {
        setSelectedRunId(null);
        setSelectedRun(null);
      }
    } catch (err) {
      if (requestVersion !== fetchVersionRef.current || requestProjectId !== projectId) return;
      setError(err instanceof Error ? err.message : "Failed to load research runs");
    } finally {
      if (requestVersion === fetchVersionRef.current) {
        setLoading(false);
      }
    }
  }, [projectId, searchQuery, selectedRunId]);

  const loadRun = useCallback(async (runId: string) => {
    const response = await getResearchRun(runId, projectId);
    setSelectedRun(response.run);
    setAvailability(response.availability);
    return response.run;
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(() => {
      void refreshRuns(searchQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [refreshRuns, searchQuery]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }
    void loadRun(selectedRunId);
  }, [loadRun, selectedRunId]);

  useEffect(() => {
    const contextVersionAtStart = projectContextVersionRef.current;
    const isStale = () => projectContextVersionRef.current !== contextVersionAtStart;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    let active = true;
    const refreshIfActive = () => {
      if (!active || isStale()) return;
      void refreshRuns();
      if (selectedRunId) {
        void loadRun(selectedRunId);
      }
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "research:run:created": refreshIfActive,
        "research:run:updated": refreshIfActive,
        "research:run:completed": refreshIfActive,
        "research:run:failed": refreshIfActive,
        "research:run:cancelled": refreshIfActive,
      },
      onReconnect: refreshIfActive,
    });

    const pollTimer = window.setInterval(refreshIfActive, POLL_INTERVAL_MS);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(pollTimer);
    };
  }, [projectId, refreshRuns, selectedRunId, loadRun]);

  return {
    runs,
    selectedRun,
    selectedRunId,
    setSelectedRunId,
    availability,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    refresh: refreshRuns,
    createRun: (input: CreateResearchRunInput) => createResearchRun(input, projectId),
    cancelRun: async (runId: string) => {
      const response = await cancelResearchRun(runId, projectId);
      if (selectedRunId === runId) {
        setSelectedRun(response.run);
      }
      await refreshRuns();
      return response;
    },
    retryRun: async (runId: string) => {
      const response = await retryResearchRun(runId, projectId);
      if (selectedRunId === runId) {
        setSelectedRun(response.run);
      }
      await refreshRuns();
      return response;
    },
    exportRun: (runId: string, format: "markdown" | "json" | "html") => exportResearchRun(runId, format, projectId),
    createTaskFromRun: (
      runId: string,
      title?: string,
      findingId?: string,
      description?: string,
      priority?: "low" | "normal" | "high" | "urgent",
      attachExport?: boolean,
    ) => createTaskFromResearchRun(runId, { title, findingId, description, priority, attachExport }, projectId),
    attachRunToTask: (runId: string, taskId: string, findingId?: string, attachExport?: boolean) =>
      attachResearchRunToTask(runId, { taskId, findingId, attachExport }, projectId),
    statusCounts: runs.reduce<Record<ResearchRunStatus, number>>(
      (acc, run) => {
        acc[run.status] += 1;
        return acc;
      },
      {
        queued: 0,
        running: 0,
        cancelling: 0,
        retry_waiting: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        timed_out: 0,
        retry_exhausted: 0,
      },
    ),
  };
}
