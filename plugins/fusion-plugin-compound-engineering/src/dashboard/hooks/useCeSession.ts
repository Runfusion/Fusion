import { useCallback, useEffect, useRef, useState } from "react";
import type { CeSession, CeSessionStatus } from "../../session/session-store.js";
import {
  answerSession as answerSessionApi,
  getSession as getSessionApi,
  resumeSession as resumeSessionApi,
  startSession as startSessionApi,
} from "./api.js";

/**
 * Injectable transport so component tests can drive the lifecycle without a
 * network. Defaults to the real polling routes.
 */
export interface CeSessionTransport {
  start(stage: string, opts: { message?: string; projectId?: string }): Promise<CeSession>;
  answer(sessionId: string, questionId: string, response: unknown, projectId?: string): Promise<CeSession>;
  resume(sessionId: string, projectId?: string): Promise<CeSession>;
  get(sessionId: string, projectId?: string): Promise<CeSession>;
}

const defaultTransport: CeSessionTransport = {
  start: (stage, opts) => startSessionApi(stage, opts),
  answer: (id, qid, response, projectId) => answerSessionApi(id, qid, response, projectId),
  resume: (id, projectId) => resumeSessionApi(id, projectId),
  get: (id, projectId) => getSessionApi(id, projectId),
};

/** Statuses where no further polling is useful (settled or waiting on the user). */
const SETTLED: ReadonlySet<CeSessionStatus> = new Set([
  "awaiting_input",
  "completed",
  "error",
  "interrupted",
]);

/**
 * Subscribe to live session push events. Called with the current sessionId +
 * projectId and a callback to invoke when this session changes; returns an
 * unsubscribe fn. Default is a no-op (polling-only) so the hook stays pure and
 * node/jsdom tests don't touch the browser SSE bus; the dashboard view injects a
 * real adapter built on the shared `/api/events` stream.
 */
export type CeSessionSubscribe = (
  sessionId: string,
  projectId: string | undefined,
  onSessionEvent: () => void,
) => () => void;

const noopSubscribe: CeSessionSubscribe = () => () => {};

export interface UseCeSessionOptions {
  /** Poll interval (ms) while a turn is running (status active/launching). */
  pollIntervalMs?: number;
  transport?: CeSessionTransport;
  /** Live push subscription (default no-op = polling only). */
  subscribe?: CeSessionSubscribe;
}

export interface UseCeSessionResult {
  session?: CeSession;
  /** True while a request (start/answer/resume) is in flight. */
  busy: boolean;
  error?: string;
  start(stage: string, opts?: { message?: string; projectId?: string }): Promise<void>;
  /** Adopt an EXISTING session (e.g. from the session list) as the active one. */
  open(sessionId: string, opts?: { projectId?: string }): Promise<void>;
  answer(questionId: string, response: unknown): Promise<void>;
  resume(): Promise<void>;
  reset(): void;
}

/**
 * Drive a single CE stage session through its lifecycle: start → watch the
 * live working output while the turn runs → render question → submit answer →
 * continue → completed/error; resume an interrupted/error session.
 *
 * Turn execution is DETACHED server-side: start/answer/resume return as soon
 * as the session row reflects the request (status `active`), and the client
 * converges via push (subscribe) with polling as the fallback. While a turn is
 * mid-flight, GET attaches `liveActivity` — the agent's streaming working
 * output — so each refetch updates the live pane.
 */
export function useCeSession(options: UseCeSessionOptions = {}): UseCeSessionResult {
  const transport = options.transport ?? defaultTransport;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const subscribe = options.subscribe ?? noopSubscribe;

  const [session, setSession] = useState<CeSession | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Keep the live id for the polling effect without re-subscribing on every
  // session field change.
  const sessionIdRef = useRef<string | undefined>(undefined);
  // The projectId used at start() selects the project-scoped store that owns the
  // session row + live handle. Every later call (answer/resume/poll) MUST reuse
  // it, or the request resolves a different store and the session isn't found.
  const projectIdRef = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((next: CeSession) => {
    sessionIdRef.current = next.id;
    if (mounted.current) setSession(next);
  }, []);

  const run = useCallback(
    async (op: () => Promise<CeSession>) => {
      setBusy(true);
      setError(undefined);
      try {
        const next = await op();
        apply(next);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [apply],
  );

  const start = useCallback(
    (stage: string, opts: { message?: string; projectId?: string } = {}) => {
      projectIdRef.current = opts.projectId;
      return run(() => transport.start(stage, opts));
    },
    [run, transport],
  );

  // Adopt an existing session (started earlier, possibly in another view visit)
  // as this hook's active session. Like start(), it pins the projectId used for
  // every subsequent call — the session row lives in that project's store.
  const open = useCallback(
    (sessionId: string, opts: { projectId?: string } = {}) => {
      projectIdRef.current = opts.projectId;
      sessionIdRef.current = sessionId;
      return run(() => transport.get(sessionId, opts.projectId));
    },
    [run, transport],
  );

  const answer = useCallback(
    (questionId: string, response: unknown) => {
      const id = sessionIdRef.current;
      if (!id) return Promise.resolve();
      return run(() => transport.answer(id, questionId, response, projectIdRef.current));
    },
    [run, transport],
  );

  const resume = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return Promise.resolve();
    return run(() => transport.resume(id, projectIdRef.current));
  }, [run, transport]);

  const reset = useCallback(() => {
    sessionIdRef.current = undefined;
    projectIdRef.current = undefined;
    setSession(undefined);
    setError(undefined);
    setBusy(false);
  }, []);

  // Live push: when the host forwards a session event over SSE, refetch the
  // persisted state immediately (lower latency than the poll interval). Polling
  // below remains as a fallback when push isn't wired or an event is missed.
  const sessionId = session?.id;
  useEffect(() => {
    if (!sessionId) return;
    return subscribe(sessionId, projectIdRef.current, () => {
      transport
        .get(sessionId, projectIdRef.current)
        .then((next) => {
          if (mounted.current) apply(next);
        })
        .catch((err: unknown) => {
          if (mounted.current) setError(err instanceof Error ? err.message : String(err));
        });
    });
  }, [sessionId, subscribe, transport, apply]);

  // Poll while a turn is mid-flight (active/launching) and we are not already
  // issuing a request. Stops as soon as the session settles.
  const status = session?.status;
  useEffect(() => {
    const id = sessionIdRef.current;
    if (!id || busy) return;
    if (!status || SETTLED.has(status)) return;

    let cancelled = false;
    const timer = setInterval(() => {
      transport
        .get(id, projectIdRef.current)
        .then((next) => {
          if (!cancelled) apply(next);
        })
        .catch((err: unknown) => {
          if (!cancelled && mounted.current) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status, busy, transport, apply, pollIntervalMs]);

  return { session, busy, error, start, open, answer, resume, reset };
}
