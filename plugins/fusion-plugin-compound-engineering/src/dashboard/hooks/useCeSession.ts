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
  answer(sessionId: string, questionId: string, response: unknown): Promise<CeSession>;
  resume(sessionId: string): Promise<CeSession>;
  get(sessionId: string): Promise<CeSession>;
}

const defaultTransport: CeSessionTransport = {
  start: (stage, opts) => startSessionApi(stage, opts),
  answer: (id, qid, response) => answerSessionApi(id, qid, response),
  resume: (id) => resumeSessionApi(id),
  get: (id) => getSessionApi(id),
};

/** Statuses where no further polling is useful (settled or waiting on the user). */
const SETTLED: ReadonlySet<CeSessionStatus> = new Set([
  "awaiting_input",
  "completed",
  "error",
  "interrupted",
]);

export interface UseCeSessionOptions {
  /** Poll interval (ms) while a turn is running (status active/launching). */
  pollIntervalMs?: number;
  transport?: CeSessionTransport;
}

export interface UseCeSessionResult {
  session?: CeSession;
  /** True while a request (start/answer/resume) is in flight. */
  busy: boolean;
  error?: string;
  start(stage: string, opts?: { message?: string; projectId?: string }): Promise<void>;
  answer(questionId: string, response: unknown): Promise<void>;
  resume(): Promise<void>;
  reset(): void;
}

/**
 * Drive a single CE stage session through its lifecycle over the polling
 * routes: start → (poll while a turn runs) → render question → submit answer →
 * continue → completed/error; resume an interrupted/error session.
 *
 * The session routes already run one turn synchronously per request and return
 * the post-turn state, so the common path settles immediately. Polling is the
 * fallback for a session left `active`/`launching` (e.g. recovered from another
 * process), honoring U5's client-polling transport.
 */
export function useCeSession(options: UseCeSessionOptions = {}): UseCeSessionResult {
  const transport = options.transport ?? defaultTransport;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;

  const [session, setSession] = useState<CeSession | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Keep the live id for the polling effect without re-subscribing on every
  // session field change.
  const sessionIdRef = useRef<string | undefined>(undefined);
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
    (stage: string, opts: { message?: string; projectId?: string } = {}) =>
      run(() => transport.start(stage, opts)),
    [run, transport],
  );

  const answer = useCallback(
    (questionId: string, response: unknown) => {
      const id = sessionIdRef.current;
      if (!id) return Promise.resolve();
      return run(() => transport.answer(id, questionId, response));
    },
    [run, transport],
  );

  const resume = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return Promise.resolve();
    return run(() => transport.resume(id));
  }, [run, transport]);

  const reset = useCallback(() => {
    sessionIdRef.current = undefined;
    setSession(undefined);
    setError(undefined);
    setBusy(false);
  }, []);

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
        .get(id)
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

  return { session, busy, error, start, answer, resume, reset };
}
