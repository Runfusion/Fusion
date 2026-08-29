import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchPrChecks, type PrCheckStatus, type PrChecksResponse } from "../api";
import { recordResumeEvent } from "../utils/resumeInstrumentation";

type RollupState = PrChecksResponse["rollup"];

interface UsePrChecksStreamOptions {
  taskId: string;
  projectId?: string;
  prNumber?: number;
  enabled?: boolean;
  initialChecks?: PrCheckStatus[];
  initialRollup?: RollupState;
  initialLastCheckedAt?: string;
}

interface UsePrChecksStreamResult {
  checks: PrCheckStatus[];
  rollup: RollupState;
  lastCheckedAt?: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const ACTIVE_INTERVAL_MS = 15_000;
const BACKOFF_INTERVAL_MS = 60_000;

export function usePrChecksStream({
  taskId,
  projectId,
  prNumber,
  enabled = true,
  initialChecks = [],
  initialRollup = "unknown",
  initialLastCheckedAt,
}: UsePrChecksStreamOptions): UsePrChecksStreamResult {
  const [checks, setChecks] = useState<PrCheckStatus[]>(initialChecks);
  const [rollup, setRollup] = useState<RollupState>(initialRollup);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | undefined>(initialLastCheckedAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableCountRef = useRef(0);
  const previousSignatureRef = useRef("");
  const pendingClearAtRef = useRef<number | null>(null);

  const shouldPoll = enabled && Boolean(taskId) && Boolean(prNumber);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const computeSignature = useCallback((items: PrCheckStatus[]) => items.map((check) => `${check.name}:${check.state}`).join("|"), []);

  const scheduleNext = useCallback((delayMs: number, run: () => void) => {
    clearTimer();
    timerRef.current = setTimeout(run, delayMs);
  }, [clearTimer]);

  const doFetch = useCallback(async () => {
    if (!shouldPoll || document.hidden) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await fetchPrChecks(taskId, projectId, prNumber);
      if (controller.signal.aborted) {
        return;
      }

      const signature = computeSignature(response.checks);
      if (signature === previousSignatureRef.current) {
        stableCountRef.current += 1;
      } else {
        previousSignatureRef.current = signature;
        stableCountRef.current = 0;
      }

      setChecks(response.checks);
      setRollup(response.rollup);
      setLastCheckedAt(response.lastCheckedAt);

      const hasPending = response.checks.some((check) => check.state === "pending");
      if (response.rollup === "success" && !hasPending) {
        if (!pendingClearAtRef.current) {
          pendingClearAtRef.current = Date.now();
        }
      } else {
        pendingClearAtRef.current = null;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [computeSignature, prNumber, projectId, shouldPoll, taskId]);

  const poll = useCallback(async () => {
    await doFetch();
    if (!shouldPoll || document.hidden) {
      return;
    }

    if (pendingClearAtRef.current && Date.now() - pendingClearAtRef.current >= BACKOFF_INTERVAL_MS) {
      clearTimer();
      return;
    }

    const delay = stableCountRef.current >= 3 ? BACKOFF_INTERVAL_MS : ACTIVE_INTERVAL_MS;
    scheduleNext(delay, () => {
      void poll();
    });
  }, [clearTimer, doFetch, scheduleNext, shouldPoll]);

  const refresh = useCallback(async () => {
    pendingClearAtRef.current = null;
    stableCountRef.current = 0;
    await doFetch();
  }, [doFetch]);

  useEffect(() => {
    const signature = computeSignature(initialChecks);
    if (signature && signature !== previousSignatureRef.current) {
      previousSignatureRef.current = signature;
      setChecks(initialChecks);
      setRollup(initialRollup);
      setLastCheckedAt(initialLastCheckedAt);
    }
  }, [computeSignature, initialChecks, initialLastCheckedAt, initialRollup]);

  useEffect(() => {
    if (!shouldPoll) {
      clearTimer();
      abortRef.current?.abort();
      return;
    }

    recordResumeEvent({
      view: "usePrChecksStream",
      trigger: "remount",
      projectId,
      replayAttempted: false,
      detail: { taskId, prNumber },
    });
    void poll();

    const onVisibilityChange = () => {
      recordResumeEvent({
        view: "usePrChecksStream",
        trigger: "visibility",
        projectId,
        replayAttempted: false,
        reason: document.hidden ? "hidden" : "visible-resume",
        detail: { taskId, prNumber },
      });
      if (document.hidden) {
        clearTimer();
        abortRef.current?.abort();
        return;
      }
      void poll();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimer();
      abortRef.current?.abort();
    };
  }, [clearTimer, poll, prNumber, projectId, shouldPoll, taskId]);

  return useMemo(() => ({
    checks,
    rollup,
    lastCheckedAt,
    loading,
    error,
    refresh,
  }), [checks, error, lastCheckedAt, loading, refresh, rollup]);
}
