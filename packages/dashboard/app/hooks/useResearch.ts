import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchRunStatus } from "@fusion/core";
import {
  ApiRequestError,
  attachResearchRunToTask,
  cancelResearchRun,
  createResearchRun,
  createTaskFromResearchRun,
  exportResearchRun,
  getResearchRun,
  listResearchRuns,
  retryResearchRun,
  type CreateResearchRunInput,
  type ResearchActionError,
  type ResearchActionErrorCode,
} from "../api";
import { subscribeSse } from "../sse-bus";
import type { ResearchAvailability, ResearchRunDetail, ResearchRunListItem } from "../research-types";

const SEARCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 4000;

const IN_FLIGHT_STATUSES: ResearchRunStatus[] = ["queued", "running", "cancelling", "retry_waiting"];

interface ResearchUiError {
  message: string;
  status?: number;
  code: ResearchActionErrorCode;
  setupHint?: string;
  retryable?: boolean;
}

function toResearchUiError(error: unknown, fallback: string): ResearchUiError {
  if (error instanceof ApiRequestError) {
    const maybeResearch = error as ResearchActionError;
    return {
      message: error.message,
      status: error.status,
      code: maybeResearch.researchCode ?? "INTERNAL_ERROR",
      setupHint: maybeResearch.setupHint,
      retryable: maybeResearch.retryable,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      code: "INTERNAL_ERROR",
    };
  }

  return {
    message: fallback,
    code: "INTERNAL_ERROR",
  };
}

function getRunActionState(run: ResearchRunDetail | null) {
  if (!run) {
    return {
      cancelable: false,
      retryable: false,
      isTransitioning: false,
      blockingReason: "No run selected",
    };
  }

  const isTransitioning = IN_FLIGHT_STATUSES.includes(run.status);
  const cancelable = run.status === "queued" || run.status === "running";
  const lifecycleRetryable = run.lifecycle?.retryable;
  const retryableTerminal = run.status === "failed" || run.status === "timed_out";
  const retryable = Boolean(retryableTerminal && lifecycleRetryable);

  let blockingReason: string | undefined;
  if (!cancelable && isTransitioning) {
    blockingReason = "Run is already transitioning";
  } else if (!cancelable && run.status === "completed") {
    blockingReason = "Completed runs cannot be cancelled";
  } else if (!cancelable && run.status === "cancelled") {
    blockingReason = "Run is already cancelled";
  } else if (!cancelable && run.status === "retry_exhausted") {
    blockingReason = "Retry attempts exhausted";
  } else if (!cancelable && run.status === "failed") {
    blockingReason = "Failed runs cannot be cancelled";
  } else if (!cancelable && run.status === "timed_out") {
    blockingReason = "Timed out runs cannot be cancelled";
  }

  if (!retryable && retryableTerminal && lifecycleRetryable === false) {
    blockingReason = run.lifecycle?.errorCode === "RETRY_EXHAUSTED"
      ? "Retry attempts exhausted"
      : "Run is not retryable";
  }

  return {
    cancelable,
    retryable,
    isTransitioning,
    blockingReason,
  };
}

export function useResearch(options?: { projectId?: string }) {
  const projectId = options?.projectId;
  const [runs, setRuns] = useState<ResearchRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ResearchRunDetail | null>(null);
  const [availability, setAvailability] = useState<ResearchAvailability>({ available: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uiError, setUiError] = useState<ResearchUiError | null>(null);
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
    setUiError(null);

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
      const normalized = toResearchUiError(err, "Failed to load research runs");
      setError(normalized.message);
      setUiError(normalized);
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
      try {
        setUiError(null);
        const response = await cancelResearchRun(runId, projectId);
        if (selectedRunId === runId) {
          setSelectedRun(response.run);
        }
        await refreshRuns();
        return response;
      } catch (err) {
        const normalized = toResearchUiError(err, "Failed to cancel run");
        setUiError(normalized);
        throw normalized;
      }
    },
    retryRun: async (runId: string) => {
      try {
        setUiError(null);
        const response = await retryResearchRun(runId, projectId);
        if (selectedRunId === runId) {
          setSelectedRun(response.run);
        }
        await refreshRuns();
        return response;
      } catch (err) {
        const normalized = toResearchUiError(err, "Failed to retry run");
        setUiError(normalized);
        throw normalized;
      }
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
    uiError,
    runActionState: getRunActionState(selectedRun),
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
