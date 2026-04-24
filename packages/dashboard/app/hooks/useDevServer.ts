import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectDevServerCommands,
  fetchDevServer,
  fetchDevServers,
  getDevServerLogsStreamUrl,
  getDevServerSessionLogsStreamUrl,
  restartDevServerById,
  setDevServerPreviewUrlById,
  startDevServerById,
  stopDevServerById,
  fetchDevServerCandidates,
  fetchDevServerStatus,
  restartDevServer,
  setDevServerPreviewUrl,
  startDevServer,
  stopDevServer,
  type DetectedDevServerCommand,
  type DevServerLogEntry,
  type DevServerSession,
  type DevServerState,
} from "../api";
import { subscribeSse } from "../sse-bus";

const MAX_LOG_LINES = 500;
const POLL_INTERVAL_MS = 3000;

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

function logEntryToString(entry: DevServerLogEntry): string {
  const text = entry.text ?? "";
  return entry.stream === "stderr" ? `[stderr] ${text}` : text;
}

function extractPreviewUrl(session: DevServerSession | null): string | null {
  return session?.previewUrl ?? null;
}

// Legacy API helpers for single-server fallback
async function legacyFetchStatus(projectId?: string) {
  return fetchDevServerStatus(projectId);
}

async function legacyStart(body: { command: string; cwd?: string; scriptName?: string; packagePath?: string }, projectId?: string) {
  return startDevServer(body, projectId);
}

async function legacyStop(projectId?: string) {
  return stopDevServer(projectId);
}

async function legacyRestart(projectId?: string) {
  return restartDevServer(projectId);
}

async function legacyDetect(projectId?: string) {
  return fetchDevServerCandidates(projectId);
}

function getOptionalExport<T>(reader: () => T): T | null {
  try {
    return reader();
  } catch {
    return null;
  }
}

function hasSessionApi(): boolean {
  return typeof getOptionalExport(() => fetchDevServers) === "function"
    && typeof getOptionalExport(() => fetchDevServer) === "function";
}

function toSessionFromLegacy(legacyState: DevServerState): DevServerSession {
  return {
    config: {
      id: legacyState.id ?? "default",
      name: legacyState.name ?? "Dev Server",
      command: legacyState.command ?? "",
      cwd: legacyState.cwd ?? ".",
    },
    status: legacyState.status as DevServerSession["status"],
    runtime: legacyState.pid
      ? {
        pid: legacyState.pid,
        startedAt: legacyState.startedAt ?? new Date().toISOString(),
        exitCode: legacyState.exitCode ?? undefined,
        previewUrl: legacyState.previewUrl,
      }
      : undefined,
    previewUrl: legacyState.previewUrl ?? legacyState.detectedUrl ?? legacyState.manualUrl ?? undefined,
    logHistory: (legacyState.logs ?? []).map<DevServerLogEntry>((text) => ({
      timestamp: new Date().toISOString(),
      stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
      text: text.replace(/^\[stderr\]\s*/, ""),
    })),
  };
}

export interface UseDevServerReturn {
  /** Current active session */
  session: DevServerSession | null;
  /** All available sessions */
  sessions: DevServerSession[];
  /** Current log entries as strings */
  logs: string[];
  /** Detected dev server commands */
  detectedCommands: DetectedDevServerCommand[];
  /** Current preview URL */
  previewUrl: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Start the dev server with the given command */
  startServer: (command: string, cwd?: string) => Promise<void>;
  /** Stop the dev server */
  stopServer: () => Promise<void>;
  /** Restart the dev server */
  restartServer: () => Promise<void>;
  /** Set the preview URL */
  setPreviewUrl: (url: string | null) => Promise<void>;
  /** Detect available dev server commands */
  detectCommands: () => Promise<void>;
  /** Refresh session state */
  refresh: () => Promise<void>;

  // Legacy aliases for compatibility
  candidates: DetectedDevServerCommand[];
  serverState: (DevServerSession & { pid?: number }) | null;
  loading: boolean;
  start: (commandOrInput: string | { command: string; cwd?: string; scriptName?: string; packagePath?: string }, cwd?: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  setManualUrl: (url: string | null) => Promise<void>;
  detect: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

export function __resetUseDevServerForTests(): void {
  // no-op: reserved hook for future test reset coordination.
}

export function useDevServer(projectId?: string): UseDevServerReturn {
  const [session, setSession] = useState<DevServerSession | null>(null);
  const [sessions, setSessions] = useState<DevServerSession[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [detectedCommands, setDetectedCommands] = useState<DetectedDevServerCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const contextVersionRef = useRef(0);
  // Track session ID for SSE subscription - this state change triggers effect re-run
  const [subscriptionSessionId, setSubscriptionSessionId] = useState<string | null>(null);

  const applySession = useCallback((newSession: DevServerSession | null) => {
    setSession(newSession);
    if (newSession?.logHistory) {
      const logStrings = newSession.logHistory
        .slice(-MAX_LOG_LINES)
        .map(logEntryToString);
      setLogs(logStrings);
    }
  }, []);

  const refresh = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;

    try {
      if (hasSessionApi()) {
        if (subscriptionSessionId) {
          const updatedSession = await fetchDevServer(subscriptionSessionId, projectId);
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          applySession(updatedSession);
        } else {
          const allSessions = await fetchDevServers(projectId);
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          setSessions(allSessions);
          if (allSessions.length > 0) {
            setSubscriptionSessionId(allSessions[0].config.id);
            applySession(allSessions[0]);
          }
        }
      } else {
        const legacyState = await legacyFetchStatus(projectId);
        if (contextVersionRef.current !== versionAtStart) {
          return;
        }
        const legacySession = toSessionFromLegacy(legacyState);
        setSessions([legacySession]);
        applySession(legacySession);
      }
      setError(null);
    } catch (refreshError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(refreshError));
    }
  }, [applySession, projectId, subscriptionSessionId]);

  useEffect(() => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    // Reset state
    setSession(null);
    setSessions([]);
    setLogs([]);
    setDetectedCommands([]);
    setIsLoading(true);
    setError(null);
    setSubscriptionSessionId(null);

    const loadInitialData = async () => {
      try {
        const [sessionsResult, commandsResult] = await Promise.allSettled([
          hasSessionApi()
            ? fetchDevServers(projectId)
            : legacyFetchStatus(projectId).then((state) => [toSessionFromLegacy(state)]),
          typeof getOptionalExport(() => detectDevServerCommands) === "function"
            ? detectDevServerCommands(projectId)
            : legacyDetect(projectId).then((legacyCandidates) => legacyCandidates.map((candidate) => ({
              name: candidate.name,
              command: candidate.command,
              cwd: candidate.cwd,
              scriptName: candidate.scriptName,
              packagePath: candidate.packagePath,
            }))),
        ]);

        if (contextVersionRef.current !== versionAtStart) {
          return;
        }

        let nextError: string | null = null;

        if (sessionsResult.status === "fulfilled") {
          const sessionsData = sessionsResult.value;
          setSessions(sessionsData);
          if (sessionsData.length > 0) {
            const firstSession = sessionsData[0];
            if (hasSessionApi()) {
              setSubscriptionSessionId(firstSession.config.id);
            }
            applySession(firstSession);
          }
        } else {
          nextError = normalizeError(sessionsResult.reason);
        }

        if (commandsResult.status === "fulfilled") {
          setDetectedCommands(commandsResult.value);
        }

        if (nextError) {
          setError(nextError);
        }
      } catch (err) {
        if (contextVersionRef.current !== versionAtStart) {
          return;
        }
        setError(normalizeError(err));
      } finally {
        if (contextVersionRef.current === versionAtStart) {
          setIsLoading(false);
        }
      }
    };

    void loadInitialData();
  }, [applySession, projectId]);

  // SSE subscription for live log updates
  useEffect(() => {
    const streamUrl = subscriptionSessionId
      ? getDevServerSessionLogsStreamUrl(subscriptionSessionId, projectId)
      : (typeof getOptionalExport(() => getDevServerLogsStreamUrl) === "function" ? getDevServerLogsStreamUrl(projectId) : null);

    if (!streamUrl) {
      return;
    }

    const versionAtStart = contextVersionRef.current;

    const unsubscribe = subscribeSse(streamUrl, {
      events: {
        history: (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<{ lines?: DevServerLogEntry[] }>(event.data);
          if (payload?.lines) {
            const logStrings = payload.lines.map(logEntryToString);
            setLogs(capLogs(logStrings));
          }
        },
        log: (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<DevServerLogEntry & { line?: string }>(event.data);
          if (payload) {
            const line = typeof payload.line === "string" ? payload.line : logEntryToString(payload);
            setLogs((prev) => appendLog(prev, line));
          }
        },
        "dev-server:log": (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<DevServerLogEntry & { line?: string }>(event.data);
          if (payload) {
            const line = typeof payload.line === "string" ? payload.line : logEntryToString(payload);
            setLogs((prev) => appendLog(prev, line));
          }
        },
        "dev-server:output": (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<{ line?: string }>(event.data);
          if (payload?.line) {
            setLogs((prev) => appendLog(prev, payload.line!));
          }
        },
        status: (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<{ status?: DevServerSession["status"]; pid?: number }>(event.data);
          const nextStatus = payload?.status;
          if (nextStatus) {
            setSession((prev) => (prev
              ? {
                ...prev,
                status: nextStatus,
                runtime: payload.pid
                  ? {
                    ...(prev.runtime ?? { startedAt: new Date().toISOString() }),
                    pid: payload.pid,
                  }
                  : prev.runtime,
              }
              : prev));
          }
        },
        "dev-server:status": (event) => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          const payload = parseJson<DevServerState>(event.data);
          if (payload?.status) {
            const nextSession = toSessionFromLegacy(payload);
            setSession(nextSession);
            setSessions([nextSession]);
          }
        },
        stopped: () => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          // Server stopped event
        },
        failed: () => {
          if (contextVersionRef.current !== versionAtStart) {
            return;
          }
          // Server failed event
        },
      },
      onReconnect: () => {
        if (contextVersionRef.current !== versionAtStart) {
          return;
        }
        void refresh();
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
  }, [projectId, refresh, subscriptionSessionId]);

  // Polling while server is running
  useEffect(() => {
    if (session?.status !== "running" && session?.status !== "starting") {
      return;
    }

    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [refresh, session?.status]);

  const startServer = useCallback(async (command: string, cwd?: string) => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    try {
      let result: DevServerSession;

      if (subscriptionSessionId && typeof getOptionalExport(() => startDevServerById) === "function") {
        result = await startDevServerById(subscriptionSessionId, projectId);
      } else {
        const legacyState = await legacyStart({ command, cwd }, projectId);
        result = toSessionFromLegacy(legacyState);
      }

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setSession(result);
      setError(null);
    } catch (startError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(startError));
      throw startError;
    }
  }, [projectId, subscriptionSessionId]);

  const stopServer = useCallback(async () => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    try {
      let result: DevServerSession;

      if (subscriptionSessionId && typeof getOptionalExport(() => stopDevServerById) === "function") {
        result = await stopDevServerById(subscriptionSessionId, projectId);
      } else {
        const legacyState = await legacyStop(projectId);
        result = toSessionFromLegacy(legacyState);
      }

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setSession(result);
      setError(null);
    } catch (stopError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(stopError));
      throw stopError;
    }
  }, [projectId, subscriptionSessionId]);

  const restartServer = useCallback(async () => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    try {
      let result: DevServerSession;

      if (subscriptionSessionId && typeof getOptionalExport(() => restartDevServerById) === "function") {
        result = await restartDevServerById(subscriptionSessionId, projectId);
      } else {
        const legacyState = await legacyRestart(projectId);
        result = toSessionFromLegacy(legacyState);
      }

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setSession(result);
      setError(null);
    } catch (restartError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(restartError));
      throw restartError;
    }
  }, [projectId, subscriptionSessionId]);

  const setPreviewUrl = useCallback(async (url: string | null) => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    try {
      let result: { url: string | null; source: string | null };

      if (subscriptionSessionId && typeof getOptionalExport(() => setDevServerPreviewUrlById) === "function") {
        result = await setDevServerPreviewUrlById(subscriptionSessionId, url, projectId);
      } else {
        const legacyState = await setDevServerPreviewUrl({ url }, projectId);
        result = {
          url: legacyState.manualUrl ?? legacyState.previewUrl ?? legacyState.detectedUrl ?? null,
          source: legacyState.manualUrl ? "manual" : "auto",
        };
      }

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      // Update session with new preview URL
      setSession((prev) => {
        if (!prev) {
          return null;
        }
        return {
          ...prev,
          previewUrl: result.url ?? undefined,
        };
      });
      setError(null);
    } catch (previewError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(previewError));
      throw previewError;
    }
  }, [projectId, subscriptionSessionId]);

  const detectCommands = useCallback(async () => {
    contextVersionRef.current += 1;
    const versionAtStart = contextVersionRef.current;

    try {
      let commands: DetectedDevServerCommand[];

      try {
        commands = await detectDevServerCommands(projectId);
      } catch {
        // Fallback to legacy detect
        const legacyCandidates = await legacyDetect(projectId);
        commands = legacyCandidates.map((candidate) => ({
          name: candidate.name,
          command: candidate.command,
          cwd: candidate.cwd,
          scriptName: candidate.scriptName,
          packagePath: candidate.packagePath,
        }));
      }

      if (contextVersionRef.current !== versionAtStart) {
        return;
      }

      setDetectedCommands(commands);
      setError(null);
    } catch (detectError) {
      if (contextVersionRef.current !== versionAtStart) {
        return;
      }
      setError(normalizeError(detectError));
      throw detectError;
    }
  }, [projectId]);

  // Legacy alias methods
  const start = useCallback(async (commandOrInput: string | { command: string; cwd?: string; scriptName?: string; packagePath?: string }, cwd?: string) => {
    if (typeof commandOrInput !== "string" && !subscriptionSessionId) {
      try {
        const input = commandOrInput;
        const legacyState = await legacyStart(
          {
            command: input.command,
            cwd: input.cwd,
            scriptName: input.scriptName,
            packagePath: input.packagePath ?? input.cwd,
          },
          projectId,
        );
        const nextSession = toSessionFromLegacy(legacyState);
        setSession(nextSession);
        setSessions([nextSession]);
        setError(null);
        return;
      } catch (legacyStartError) {
        setError(normalizeError(legacyStartError));
        throw legacyStartError;
      }
    }

    const command = typeof commandOrInput === "string" ? commandOrInput : commandOrInput.command;
    const cwdArg = typeof commandOrInput === "string" ? cwd : commandOrInput.cwd;
    await startServer(command, cwdArg);
  }, [projectId, startServer, subscriptionSessionId]);

  const stop = useCallback(async () => {
    await stopServer();
  }, [stopServer]);

  const restart = useCallback(async () => {
    await restartServer();
  }, [restartServer]);

  const setManualUrl = useCallback(async (url: string | null) => {
    await setPreviewUrl(url);
  }, [setPreviewUrl]);

  const detect = useCallback(async () => {
    await detectCommands();
  }, [detectCommands]);

  const refreshStatus = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const previewUrl = extractPreviewUrl(session);
  const serverState = session ? { ...session, pid: session.runtime?.pid } : null;

  return {
    session,
    sessions,
    logs,
    detectedCommands,
    previewUrl,
    isLoading,
    error,
    startServer,
    stopServer,
    restartServer,
    setPreviewUrl,
    detectCommands,
    refresh,
    // Legacy aliases
    candidates: detectedCommands,
    serverState,
    loading: isLoading,
    // Legacy methods
    start,
    stop,
    restart,
    setManualUrl,
    detect,
    refreshStatus,
  };
}
