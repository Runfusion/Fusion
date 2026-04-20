import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDevServerCandidates,
  fetchDevServerStatus,
  getDevServerLogsStreamUrl,
  restartDevServer,
  setDevServerPreviewUrl,
  startDevServer,
  stopDevServer,
  type DevServerCandidate,
  type DevServerState,
} from "../api";

const POLL_INTERVAL_MS = 3000;
const MAX_LOG_LINES = 500;

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLines(lines: string[]): string[] {
  if (lines.length <= MAX_LOG_LINES) {
    return lines;
  }
  return lines.slice(-MAX_LOG_LINES);
}

function appendLine(lines: string[], line: string): string[] {
  return normalizeLines([...lines, line]);
}

function parseEventData<T>(event: MessageEvent<string>): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

export interface UseDevServerReturn {
  candidates: DevServerCandidate[];
  serverState: DevServerState | null;
  logs: string[];
  start: (arg: DevServerCandidate | { command: string; scriptName: string; cwd?: string }) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  setPreviewUrl: (url: string | null) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function useDevServer(projectId?: string): UseDevServerReturn {
  const [candidates, setCandidates] = useState<DevServerCandidate[]>([]);
  const [serverState, setServerState] = useState<DevServerState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pollingIntervalRef = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const contextVersionRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const applyServerState = useCallback((nextState: DevServerState) => {
    setServerState(nextState);
    setLogs((prev) => {
      if (!Array.isArray(nextState.logs)) {
        return prev;
      }
      if (prev.length === nextState.logs.length && prev.every((line, index) => line === nextState.logs[index])) {
        return prev;
      }
      return normalizeLines(nextState.logs);
    });
  }, []);

  const pollStatus = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;

    try {
      const nextState = await fetchDevServerStatus(projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      applyServerState(nextState);
      setError(null);
    } catch (pollError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(pollError));
      stopPolling();
    }
  }, [applyServerState, projectId, stopPolling]);

  useEffect(() => {
    const versionAtStart = contextVersionRef.current + 1;
    contextVersionRef.current = versionAtStart;

    setCandidates([]);
    setServerState(null);
    setLogs([]);
    setLoading(true);
    setError(null);

    stopPolling();
    closeEventSource();

    void Promise.allSettled([
      fetchDevServerCandidates(projectId),
      fetchDevServerStatus(projectId),
    ]).then((results) => {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      const [candidatesResult, statusResult] = results;
      let nextError: string | null = null;

      if (candidatesResult.status === "fulfilled") {
        setCandidates(candidatesResult.value);
      } else {
        nextError = normalizeError(candidatesResult.reason);
      }

      if (statusResult.status === "fulfilled") {
        applyServerState(statusResult.value);
      } else {
        nextError ??= normalizeError(statusResult.reason);
      }

      setError(nextError);
      setLoading(false);
    });

    return () => {
      stopPolling();
      closeEventSource();
    };
  }, [applyServerState, closeEventSource, projectId, stopPolling]);

  useEffect(() => {
    const status = serverState?.status;
    const shouldPoll = status === "starting" || status === "running";

    if (!shouldPoll) {
      stopPolling();
      return;
    }

    if (pollingIntervalRef.current !== null) {
      return;
    }

    pollingIntervalRef.current = window.setInterval(() => {
      void pollStatus();
    }, POLL_INTERVAL_MS);

    return () => {
      stopPolling();
    };
  }, [pollStatus, serverState?.status, stopPolling]);

  useEffect(() => {
    const versionAtStart = contextVersionRef.current;
    const eventSource = new EventSource(getDevServerLogsStreamUrl(projectId));
    eventSourceRef.current = eventSource;

    const handleHistory = (event: MessageEvent<string>) => {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      const payload = parseEventData<{ lines?: string[] }>(event);
      if (!payload || !Array.isArray(payload.lines)) {
        return;
      }

      setLogs(normalizeLines(payload.lines.filter((line): line is string => typeof line === "string")));
    };

    const handleLog = (event: MessageEvent<string>) => {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      const payload = parseEventData<{ line?: string }>(event);
      const line = typeof payload?.line === "string" ? payload.line : event.data;
      setLogs((prev) => appendLine(prev, line));
    };

    const handleTerminalStateEvent = () => {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      void pollStatus();
    };

    const handleError = () => {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      eventSource.close();
      eventSourceRef.current = null;
    };

    eventSource.addEventListener("history", handleHistory);
    eventSource.addEventListener("log", handleLog);
    eventSource.addEventListener("stopped", handleTerminalStateEvent);
    eventSource.addEventListener("failed", handleTerminalStateEvent);
    eventSource.addEventListener("error", handleError);

    return () => {
      eventSource.removeEventListener("history", handleHistory);
      eventSource.removeEventListener("log", handleLog);
      eventSource.removeEventListener("stopped", handleTerminalStateEvent);
      eventSource.removeEventListener("failed", handleTerminalStateEvent);
      eventSource.removeEventListener("error", handleError);
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
    };
  }, [pollStatus, projectId]);

  const start = useCallback(async (arg: DevServerCandidate | { command: string; scriptName: string; cwd?: string }) => {
    const versionAtStart = contextVersionRef.current;

    const payload = "label" in arg
      ? {
        command: arg.command,
        scriptName: arg.scriptName,
        cwd: arg.cwd,
      }
      : {
        command: arg.command,
        scriptName: arg.scriptName,
        cwd: arg.cwd,
      };

    setError(null);

    try {
      const nextState = await startDevServer(
        {
          command: payload.command.trim(),
          scriptName: payload.scriptName.trim(),
          cwd: payload.cwd,
        },
        projectId,
      );

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      applyServerState(nextState);
    } catch (startError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      const message = normalizeError(startError);
      setError(message);
      throw startError;
    }
  }, [applyServerState, projectId]);

  const stop = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    setError(null);

    try {
      const nextState = await stopDevServer(projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      applyServerState(nextState);
    } catch (stopError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(stopError));
      throw stopError;
    }
  }, [applyServerState, projectId]);

  const restart = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    setError(null);

    try {
      const nextState = await restartDevServer(projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      applyServerState(nextState);
    } catch (restartError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(restartError));
      throw restartError;
    }
  }, [applyServerState, projectId]);

  const setPreviewUrl = useCallback(async (url: string | null) => {
    const versionAtStart = contextVersionRef.current;
    setError(null);

    try {
      const nextState = await setDevServerPreviewUrl({ url }, projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      applyServerState(nextState);
    } catch (previewError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(previewError));
      throw previewError;
    }
  }, [applyServerState, projectId]);

  return {
    candidates,
    serverState,
    logs,
    start,
    stop,
    restart,
    setPreviewUrl,
    loading,
    error,
  };
}
