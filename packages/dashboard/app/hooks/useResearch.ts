import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchRunStatus } from "@fusion/core";
import {
  ApiRequestError,
  attachResearchRunToTask,
  cancelResearchRun,
  createResearchRun,
  createTaskFromResearchRun,
  promoteResearchFinding,
  exportResearchRun,
  getResearchRun,
  listResearchRuns,
  retryResearchRun,
  type CreateResearchRunInput,
  type ResearchActionError,
  type ResearchActionErrorCode,
} from "../api";
import { subscribeSse } from "../sse-bus";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import type { ResearchAvailability, ResearchRunDetail, ResearchRunListItem } from "../research-types";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, SWR_LONG_MAX_AGE_MS, writeCache } from "../utils/swrCache";

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
  const cacheSuffix = projectId ?? "";
  const runsCacheKey = `${SWR_CACHE_KEYS.RESEARCH_RUNS_PREFIX}${cacheSuffix}`;
  const selectedIdCacheKey = `${SWR_CACHE_KEYS.RESEARCH_SELECTED_ID_PREFIX}${cacheSuffix}`;
  const initialRuns = readCache<ResearchRunListItem[]>(runsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
  const initialSelectedId = readCache<string | null>(selectedIdCacheKey, { maxAgeMs: SWR_LONG_MAX_AGE_MS });
  const hasHydratedRef = useRef(Array.isArray(initialRuns) && initialRuns.length > 0);
  const [runs, setRuns] = useState<ResearchRunListItem[]>(() => (Array.isArray(initialRuns) ? initialRuns : []));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialSelectedId ?? null);
  const [selectedRun, setSelectedRun] = useState<ResearchRunDetail | null>(null);
  const [availability, setAvailability] = useState<ResearchAvailability>({ available: true });
  const [loading, setLoading] = useState(!(Array.isArray(initialRuns) && initialRuns.length > 0));
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

    const cachedRuns = readCache<ResearchRunListItem[]>(runsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const cachedSelectedId = readCache<string | null>(selectedIdCacheKey, { maxAgeMs: SWR_LONG_MAX_AGE_MS });
    const hasCachedRuns = Array.isArray(cachedRuns) && cachedRuns.length > 0;

    setRuns(Array.isArray(cachedRuns) ? cachedRuns : []);
    setSelectedRunId(cachedSelectedId ?? null);
    setSelectedRun(null);
    setLoading(!hasCachedRuns);
    hasHydratedRef.current = hasCachedRuns;
  }, [projectId, runsCacheKey, selectedIdCacheKey]);

  const refreshRuns = useCallback(async (query = searchQuery) => {
    const requestVersion = ++fetchVersionRef.current;
    const requestProjectId = projectId;

    if (!hasHydratedRef.current) {
      setLoading(true);
    }
    setError(null);
    setUiError(null);

    try {
      const response = await listResearchRuns({ q: query || undefined, limit: 100 }, requestProjectId);
      if (requestVersion !== fetchVersionRef.current || requestProjectId !== projectId) return;
      setRuns(response.runs);
      writeCache(runsCacheKey, response.runs, { maxBytes: 500_000 });
      hasHydratedRef.current = true;
      setAvailability(response.availability);
      if (selectedRunId && !response.runs.some((run) => run.id === selectedRunId)) {
        setSelectedRunId(null);
        writeCache(selectedIdCacheKey, null, { maxBytes: 500_000 });
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
  }, [projectId, runsCacheKey, searchQuery, selectedIdCacheKey, selectedRunId]);

  const loadRun = useCallback(async (runId: string) => {
    const response = await getResearchRun(runId, projectId);
    setSelectedRun(response.run);
    setAvailability(response.availability);
    return response.run;
  }, [projectId]);

  useEffect(() => {
    if (!hasHydratedRef.current) {
      setLoading(true);
    }
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

    const sseChannel = `/api/events${query}`;
    const unsubscribe = subscribeSse(sseChannel, {
      events: {
        "research:run:created": refreshIfActive,
        "research:run:updated": refreshIfActive,
        "research:run:completed": refreshIfActive,
        "research:run:failed": refreshIfActive,
        "research:run:cancelled": refreshIfActive,
      },
      onReconnect: () => {
        recordResumeEvent({
          view: "useResearch",
          trigger: "sse-reconnect",
          projectId,
          replayAttempted: false,
          sseChannel,
        });
        refreshIfActive();
      },
    });
    recordResumeEvent({
      view: "useResearch",
      trigger: "sse-open",
      projectId,
      replayAttempted: false,
      sseChannel,
    });

    const pollTimer = window.setInterval(refreshIfActive, POLL_INTERVAL_MS);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(pollTimer);
    };
  }, [projectId, refreshRuns, selectedRunId, loadRun]);

  const setSelectedRunIdAndCache = useCallback((value: string | null) => {
    setSelectedRunId(value);
    writeCache(selectedIdCacheKey, value, { maxBytes: 500_000 });
  }, [selectedIdCacheKey]);

  return {
    runs,
    selectedRun,
    selectedRunId,
    setSelectedRunId: setSelectedRunIdAndCache,
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
    promoteFinding: (runId: string, input: { findingId: string; sliceId: string; title?: string; description?: string; acceptanceCriteria?: string; triage?: boolean; taskId?: string }) =>
      promoteResearchFinding(runId, input, projectId),
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
