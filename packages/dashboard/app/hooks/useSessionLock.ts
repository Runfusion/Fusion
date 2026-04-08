import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acquireSessionLock,
  forceAcquireSessionLock,
  releaseSessionLock,
  type AiSessionSummary,
} from "../api";
import { getSessionTabId } from "../utils/getSessionTabId";

interface SessionLockState {
  isLockedByOther: boolean;
  currentHolder: string | null;
  takeControl: () => Promise<void>;
  isLoading: boolean;
}

export function useSessionLock(sessionId: string | null): SessionLockState {
  const tabId = useMemo(() => getSessionTabId(), []);
  const [isLockedByOther, setIsLockedByOther] = useState(false);
  const [currentHolder, setCurrentHolder] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setIsLockedByOther(false);
      setCurrentHolder(null);
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);

    void Promise.resolve(acquireSessionLock(sessionId, tabId))
      .then((result) => {
        if (!active) return;

        if (result.acquired) {
          setIsLockedByOther(false);
          setCurrentHolder(null);
          return;
        }

        setIsLockedByOther(true);
        setCurrentHolder(result.currentHolder);
      })
      .catch(() => {
        if (!active) return;
        setIsLockedByOther(false);
        setCurrentHolder(null);
      })
      .finally(() => {
        if (!active) return;
        setIsLoading(false);
      });

    return () => {
      active = false;
      try {
        const releaseResult = releaseSessionLock(sessionId, tabId) as Promise<void> | void;
        if (releaseResult && typeof releaseResult.catch === "function") {
          void releaseResult.catch(() => {
            // best-effort on unmount
          });
        }
      } catch {
        // best-effort on unmount
      }
    };
  }, [sessionId, tabId]);

  useEffect(() => {
    if (!sessionId || typeof window === "undefined") {
      return;
    }

    const handleBeforeUnload = () => {
      if (typeof navigator.sendBeacon !== "function") {
        return;
      }

      const url = `/api/ai-sessions/${encodeURIComponent(sessionId)}/lock/beacon?tabId=${encodeURIComponent(tabId)}`;
      navigator.sendBeacon(url);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [sessionId, tabId]);

  useEffect(() => {
    if (!sessionId || typeof EventSource === "undefined") {
      return;
    }

    const eventSource = new EventSource("/api/events");

    const handleUpdated = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as AiSessionSummary;
        if (payload.id !== sessionId) {
          return;
        }

        const holder = payload.lockedByTab ?? null;
        setCurrentHolder(holder);
        setIsLockedByOther(Boolean(holder && holder !== tabId));
      } catch {
        // ignore malformed events
      }
    };

    eventSource.addEventListener("ai_session:updated", handleUpdated as EventListener);

    return () => {
      eventSource.removeEventListener("ai_session:updated", handleUpdated as EventListener);
      eventSource.close();
    };
  }, [sessionId, tabId]);

  const takeControl = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setIsLoading(true);
    try {
      await Promise.resolve(forceAcquireSessionLock(sessionId, tabId));
      setIsLockedByOther(false);
      setCurrentHolder(null);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, tabId]);

  return {
    isLockedByOther,
    currentHolder,
    takeControl,
    isLoading,
  };
}
