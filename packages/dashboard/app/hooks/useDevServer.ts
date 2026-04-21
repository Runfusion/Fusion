import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { subscribeSse } from "../sse-bus";

const MAX_LOG_LINES = 500;
const POLL_INTERVAL_MS = 3000;

let resetVersion = 0;

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capLogs(lines: string[]): string[] {
  if (lines.length <= MAX_LOG_LINES) {
    return lines;
  }
  return lines.slice(-MAX_LOG_LINES);
}

function appendLog(lines: string[], line: string): string[] {
  return capLogs([...lines, line]);
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function mapStateToHook(state: DevServerState | null): Pick<UseDevServerReturn, "status" | "detectedUrl" | "manualUrl" | "selectedCommand" | "serverState"> {
  if (!state) {
    return {
      status: "stopped",
      detectedUrl: null,
      manualUrl: null,
      selectedCommand: null,
      serverState: null,
    };
  }

  return {
    status: state.status,
    detectedUrl: state.detectedUrl ?? state.previewUrl ?? null,
    manualUrl: state.manualUrl ?? state.manualPreviewUrl ?? null,
    selectedCommand: state.command?.trim().length ? state.command : null,
    serverState: state,
  };
}

type DevServerStartArgs =
  | string
  | DevServerCandidate
  | {
    command: string;
    cwd?: string;
    scriptName?: string;
    packagePath?: string;
  };

export interface UseDevServerReturn {
  status: "starting" | "running" | "stopped" | "failed";
  logs: string[];
  detectedUrl: string | null;
  manualUrl: string | null;
  selectedCommand: string | null;
  candidates: DevServerCandidate[];
  isLoading: boolean;
  error: string | null;
  start: (commandOrInput: DevServerStartArgs, cwd?: string, scriptName?: string, packagePath?: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  setManualUrl: (url: string | null) => Promise<void>;
  detect: () => Promise<void>;
  refreshStatus: () => Promise<void>;

  // Back-compat aliases used by existing consumers/tests.
  serverState: DevServerState | null;
  loading: boolean;
  setPreviewUrl: (url: string | null) => Promise<void>;
}

export function __resetUseDevServerForTests(): void {
  resetVersion += 1;
}

export function useDevServer(projectId?: string): UseDevServerReturn {
  const [status, setStatus] = useState<UseDevServerReturn["status"]>("stopped");
  const [logs, setLogs] = useState<string[]>([]);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [manualUrl, setManualUrlState] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DevServerCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverState, setServerState] = useState<DevServerState | null>(null);

  const contextVersionRef = useRef(0);

  const applyStatusState = useCallback((state: DevServerState) => {
    const mapped = mapStateToHook(state);
    setStatus(mapped.status);
    setDetectedUrl(mapped.detectedUrl);
    setManualUrlState(mapped.manualUrl);
    setSelectedCommand(mapped.selectedCommand);
    setServerState(mapped.serverState);
    if (Array.isArray(state.logs)) {
      setLogs(capLogs(state.logs));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;

    try {
      const nextState = await fetchDevServerStatus(projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      applyStatusState(nextState);
      setError(null);
    } catch (refreshError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(refreshError));
      throw refreshError;
    }
  }, [applyStatusState, projectId]);

  useEffect(() => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    setStatus("stopped");
    setLogs([]);
    setDetectedUrl(null);
    setManualUrlState(null);
    setSelectedCommand(null);
    setCandidates([]);
    setIsLoading(true);
    setError(null);
    setServerState(null);

    void Promise.allSettled([
      fetchDevServerCandidates(projectId),
      fetchDevServerStatus(projectId),
    ]).then(([candidateResult, statusResult]) => {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      let nextError: string | null = null;

      if (candidateResult.status === "fulfilled") {
        setCandidates(candidateResult.value);
      } else {
        nextError = normalizeError(candidateResult.reason);
      }

      if (statusResult.status === "fulfilled") {
        applyStatusState(statusResult.value);
      } else {
        nextError = nextError ?? normalizeError(statusResult.reason);
      }

      setError(nextError);
      setIsLoading(false);
    });

    return () => {
      contextVersionRef.current += 1;
    };
  }, [applyStatusState, projectId]);

  useEffect(() => {
    if (status !== "running" && status !== "starting") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshStatus().catch(() => {
        // Errors are recorded in hook state.
      });
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshStatus, status]);

  useEffect(() => {
    const versionAtStart = contextVersionRef.current;

    const unsubscribe = subscribeSse(getDevServerLogsStreamUrl(projectId), {
      events: {
        history: (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }

          const payload = parseJson<{ lines?: Array<string | { text?: string; line?: string; stream?: "stdout" | "stderr" }> }>(event.data);
          const nextLogs = Array.isArray(payload?.lines)
            ? payload.lines.map((entry) => {
              if (typeof entry === "string") {
                return entry;
              }
              const text = typeof entry?.text === "string" ? entry.text : (typeof entry?.line === "string" ? entry.line : "");
              const stream = entry?.stream;
              return stream === "stderr" ? `[stderr] ${text}` : text;
            }).filter((line) => line.length > 0)
            : [];
          if (nextLogs.length > 0) {
            setLogs(capLogs(nextLogs));
          }
        },
        log: (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }

          const payload = parseJson<{ line?: string; text?: string; stream?: "stdout" | "stderr" }>(event.data);
          const text = typeof payload?.line === "string"
            ? payload.line
            : typeof payload?.text === "string"
              ? payload.text
              : event.data;
          const stream = payload?.stream;
          const formatted = stream === "stderr" ? `[stderr] ${text}` : text;
          setLogs((current) => appendLog(current, formatted));
          setError(null);
        },
        "dev-server:log": (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }

          const payload = parseJson<{ line?: string; text?: string; stream?: "stdout" | "stderr" }>(event.data);
          const text = typeof payload?.line === "string"
            ? payload.line
            : typeof payload?.text === "string"
              ? payload.text
              : event.data;
          const stream = payload?.stream;
          const formatted = stream === "stderr" ? `[stderr] ${text}` : text;
          setLogs((current) => appendLog(current, formatted));
          setError(null);
        },
        "dev-server:output": (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }

          const payload = parseJson<{ text?: string; stream?: "stdout" | "stderr" }>(event.data);
          if (!payload?.text) {
            return;
          }
          const formatted = payload.stream === "stderr" ? `[stderr] ${payload.text}` : payload.text;
          setLogs((current) => appendLog(current, formatted));
          setError(null);
        },
        status: (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<DevServerState>(event.data);
          if (payload) {
            applyStatusState(payload);
            setError(null);
          }
        },
        "dev-server:status": (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<DevServerState>(event.data);
          if (payload) {
            applyStatusState(payload);
            setError(null);
          }
        },
        stopped: () => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          void refreshStatus().catch(() => {
            // Errors are recorded in hook state.
          });
        },
        failed: () => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          void refreshStatus().catch(() => {
            // Errors are recorded in hook state.
          });
        },
      },
      onReconnect: () => {
        if (contextVersionRef.current !== versionAtStart) {
          return;
        }
        void refreshStatus().catch(() => {
          // Errors are recorded in hook state.
        });
      },
      onError: () => {
        if (contextVersionRef.current !== versionAtStart) {
          return;
        }
        setError((current) => current ?? "Lost log stream connection.");
      },
    });

    return () => {
      unsubscribe();
    };
  }, [applyStatusState, projectId, refreshStatus]);

  useEffect(() => {
    const version = resetVersion;
    return () => {
      if (resetVersion !== version) {
        contextVersionRef.current += 1;
      }
    };
  }, []);

  const start = useCallback(async (
    commandOrInput: DevServerStartArgs,
    cwd?: string,
    scriptName?: string,
    packagePath?: string,
  ) => {
    const payload = typeof commandOrInput === "string"
      ? {
        command: commandOrInput,
        cwd,
        scriptName,
        packagePath,
      }
      : {
        command: commandOrInput.command,
        cwd: commandOrInput.cwd ?? cwd,
        scriptName: commandOrInput.scriptName ?? scriptName,
        packagePath: commandOrInput.packagePath ?? cwd ?? commandOrInput.cwd ?? packagePath,
      };

    const trimmedCommand = payload.command.trim();
    if (!trimmedCommand) {
      const message = "Command is required to start the dev server.";
      setError(message);
      throw new Error(message);
    }

    const versionAtStart = contextVersionRef.current;
    setError(null);
    setStatus("starting");
    setSelectedCommand(trimmedCommand);

    try {
      const nextState = await startDevServer(
        {
          command: trimmedCommand,
          cwd: payload.cwd,
          scriptName: payload.scriptName,
          packagePath: payload.packagePath,
        },
        projectId,
      );

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      applyStatusState(nextState);
      setError(null);
    } catch (startError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setStatus("failed");
      setError(normalizeError(startError));
      throw startError;
    }
  }, [applyStatusState, projectId]);

  const stop = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    setError(null);

    try {
      const nextState = await stopDevServer(projectId);

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      applyStatusState(nextState);
      setError(null);
    } catch (stopError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setError(normalizeError(stopError));
      throw stopError;
    }
  }, [applyStatusState, projectId]);

  const restart = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    setError(null);
    setStatus("starting");

    try {
      const nextState = await restartDevServer(projectId);

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      applyStatusState(nextState);
      setError(null);
    } catch (restartError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setError(normalizeError(restartError));
      throw restartError;
    }
  }, [applyStatusState, projectId]);

  const setManualUrl = useCallback(async (url: string | null) => {
    const versionAtStart = contextVersionRef.current;
    setError(null);

    try {
      const nextState = await setDevServerPreviewUrl({ url }, projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      applyStatusState(nextState);
      setManualUrlState(nextState.manualUrl ?? nextState.manualPreviewUrl ?? url ?? null);
      setError(null);
    } catch (previewError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setError(normalizeError(previewError));
      throw previewError;
    }
  }, [applyStatusState, projectId]);

  const detect = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    setError(null);

    try {
      const detected = await fetchDevServerCandidates(projectId);
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setCandidates(detected);
      setError(null);
    } catch (detectError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setError(normalizeError(detectError));
      throw detectError;
    }
  }, [projectId]);

  const setPreviewUrl = useCallback((url: string | null) => setManualUrl(url), [setManualUrl]);

  return useMemo(() => ({
    status,
    logs,
    detectedUrl,
    manualUrl,
    selectedCommand,
    candidates,
    isLoading,
    error,
    start,
    stop,
    restart,
    setManualUrl,
    detect,
    refreshStatus,

    serverState,
    loading: isLoading,
    setPreviewUrl,
  }), [
    status,
    logs,
    detectedUrl,
    manualUrl,
    selectedCommand,
    candidates,
    isLoading,
    error,
    start,
    stop,
    restart,
    setManualUrl,
    detect,
    refreshStatus,
    serverState,
    setPreviewUrl,
  ]);
}
