import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalCategoryScore, EvalEvidenceReference, EvalFollowUpSuggestion } from "@fusion/core";
import { getEval, listEvalRuns, listEvals } from "../api";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

const FILTER_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 15_000;

export interface NormalizedEvalSummary {
  id: string;
  runId: string;
  taskId: string;
  taskTitle: string;
  createdAt: string;
  overallScore: number | null;
  maxScore: number | null;
  categoryScores: EvalCategoryScore[];
}

export interface NormalizedEvalDetail extends NormalizedEvalSummary {
  rationale: string;
  evidence: EvalEvidenceReference[];
  followUps: EvalFollowUpSuggestion[];
}

interface EvalFilters {
  q: string;
  runId: string;
  scoreMin: string;
  scoreMax: string;
}

function toNumberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstArray<T>(...values: unknown[]): T[] {
  for (const value of values) {
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeSummary(raw: unknown): NormalizedEvalSummary {
  const item = asRecord(raw);
  const snapshot = asRecord(item.taskSnapshot);
  return {
    id: String(item.id ?? item.evalId ?? ""),
    runId: String(item.runId ?? item.batchId ?? ""),
    taskId: String(item.taskId ?? snapshot.taskId ?? ""),
    taskTitle: String(snapshot.title ?? item.taskTitle ?? item.title ?? "Untitled task"),
    createdAt: String(item.createdAt ?? item.timestamp ?? item.updatedAt ?? new Date(0).toISOString()),
    overallScore: typeof item.overallScore === "number" ? item.overallScore : null,
    maxScore: typeof item.maxScore === "number" ? item.maxScore : null,
    categoryScores: firstArray<EvalCategoryScore>(item.categoryScores, asRecord(item.scores).categories),
  };
}

function normalizeDetail(raw: unknown): NormalizedEvalDetail {
  const item = asRecord(raw);
  const summary = normalizeSummary(item);
  return {
    ...summary,
    rationale: String(item.rationale ?? item.summary ?? ""),
    evidence: firstArray<EvalEvidenceReference>(item.evidence, asRecord(item.details).evidence),
    followUps: firstArray<EvalFollowUpSuggestion>(item.followUps, asRecord(item.recommendations).followUps),
  };
}

export function useEvals(options?: { projectId?: string }) {
  const projectId = options?.projectId;
  const cacheSuffix = projectId ?? "";
  const runsCacheKey = `${SWR_CACHE_KEYS.EVALS_RUNS_PREFIX}${cacheSuffix}`;
  const resultsCacheKey = `${SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX}${cacheSuffix}`;
  const initialRuns = readCache<Array<{ id: string; createdAt: string; completedAt?: string; status: string; evaluatedTaskCount: number }>>(runsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
  const initialResults = readCache<NormalizedEvalSummary[]>(resultsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
  const hasHydratedRef = useRef(
    (Array.isArray(initialRuns) && initialRuns.length > 0) || (Array.isArray(initialResults) && initialResults.length > 0),
  );
  const [filters, setFilters] = useState<EvalFilters>({ q: "", runId: "", scoreMin: "", scoreMax: "" });
  const [runs, setRuns] = useState<Array<{ id: string; createdAt: string; completedAt?: string; status: string; evaluatedTaskCount: number }>>(() => (Array.isArray(initialRuns) ? initialRuns : []));
  const [results, setResults] = useState<NormalizedEvalSummary[]>(() => (Array.isArray(initialResults) ? initialResults : []));
  const [selectedEvalId, setSelectedEvalIdState] = useState<string | null>(null);
  const [selectedEval, setSelectedEval] = useState<NormalizedEvalDetail | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(!hasHydratedRef.current);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  const selectedEvalIdRef = useRef<string | null>(selectedEvalId);
  selectedEvalIdRef.current = selectedEvalId;

  const refresh = useCallback(async () => {
    const version = ++requestVersionRef.current;
    if (!hasHydratedRef.current) {
      setLoading(true);
    }
    setError(null);

    try {
      const [listResponse, runsResponse] = await Promise.all([
        listEvals({
          q: filters.q || undefined,
          runId: filters.runId || undefined,
          scoreMin: toNumberOrUndefined(filters.scoreMin),
          scoreMax: toNumberOrUndefined(filters.scoreMax),
          limit: 100,
          offset: 0,
        }, projectId),
        listEvalRuns(projectId),
      ]);
      if (version !== requestVersionRef.current) return;

      const rawResults = firstArray(listResponse.results, (listResponse as unknown as Record<string, unknown>).evals, (listResponse as unknown as Record<string, unknown>).items);
      const normalizedResults = rawResults.map(normalizeSummary);
      setResults(normalizedResults);
      writeCache(
        resultsCacheKey,
        normalizedResults.length > 500 ? normalizedResults.slice(0, 500) : normalizedResults,
        { maxBytes: 500_000 },
      );
      setCount(typeof listResponse.count === "number" ? listResponse.count : normalizedResults.length);

      const rawRuns = firstArray(runsResponse.runs, (runsResponse as unknown as Record<string, unknown>).items);
      const normalizedRuns = rawRuns.map((run) => {
        const runRecord = asRecord(run);
        const counts = asRecord(runRecord.counts);
        return {
          id: String(runRecord.id ?? ""),
          createdAt: String(runRecord.createdAt ?? ""),
          completedAt: typeof runRecord.completedAt === "string" ? runRecord.completedAt : undefined,
          status: String(runRecord.status ?? "pending"),
          evaluatedTaskCount: typeof counts.totalTasks === "number" ? counts.totalTasks : 0,
        };
      });
      setRuns(normalizedRuns);
      writeCache(runsCacheKey, normalizedRuns, { maxBytes: 500_000 });
      hasHydratedRef.current = true;

      if (selectedEvalIdRef.current && !normalizedResults.some((result) => result.id === selectedEvalIdRef.current)) {
        setSelectedEvalIdState(null);
        setSelectedEval(null);
      }
    } catch (err) {
      if (version !== requestVersionRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load evals");
    } finally {
      if (version === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }, [filters.q, filters.runId, filters.scoreMax, filters.scoreMin, projectId, resultsCacheKey, runsCacheKey]);

  const loadDetail = useCallback(async (evalId: string) => {
    const response = await getEval(evalId, projectId);
    const payload = (response as unknown as Record<string, unknown>).result ?? response;
    setSelectedEval(normalizeDetail(payload));
  }, [projectId]);

  useEffect(() => {
    if (previousProjectIdRef.current === projectId) {
      return;
    }
    previousProjectIdRef.current = projectId;

    const cachedRuns = readCache<Array<{ id: string; createdAt: string; completedAt?: string; status: string; evaluatedTaskCount: number }>>(runsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const cachedResults = readCache<NormalizedEvalSummary[]>(resultsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const hasCached =
      (Array.isArray(cachedRuns) && cachedRuns.length > 0) ||
      (Array.isArray(cachedResults) && cachedResults.length > 0);

    setRuns(Array.isArray(cachedRuns) ? cachedRuns : []);
    setResults(Array.isArray(cachedResults) ? cachedResults : []);
    setLoading(!hasCached);
    hasHydratedRef.current = hasCached;
  }, [projectId, resultsCacheKey, runsCacheKey]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

  useEffect(() => {
    if (!selectedEvalId) {
      setSelectedEval(null);
      return;
    }
    void loadDetail(selectedEvalId);
  }, [loadDetail, selectedEvalId]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:42:
  The evals list/detail poll is suspended while the document is hidden. Even a view-scoped 15s loop keeps a
  backgrounded mobile tab "busy" and eligible for OS discard, which surfaces as a white-splash reload when
  the operator switches back; the hidden -> visible edge polls once so results are fresh on return.
  */
  const pollEvals = useCallback(() => {
    void refresh();
    if (selectedEvalId) {
      void loadDetail(selectedEvalId);
    }
  }, [loadDetail, refresh, selectedEvalId]);
  useVisibilityAwarePoll(pollEvals, POLL_INTERVAL_MS);

  const setSelectedEvalId = useCallback((value: string | null) => {
    selectedEvalIdRef.current = value;
    setSelectedEvalIdState(value);
  }, []);

  return {
    loading,
    error,
    results,
    count,
    runs,
    filters,
    setFilters,
    refresh,
    selectedEvalId,
    setSelectedEvalId,
    selectedEval,
  };
}
