import { useCallback, useEffect, useRef, useState } from "react";
import type { CeSession } from "../../session/session-store.js";
import { deleteSession as deleteSessionApi, listSessions as listSessionsApi } from "./api.js";

/**
 * Injectable list transport so component tests can drive the session list
 * without a network. Defaults to the real routes.
 */
export interface CeSessionsTransport {
  list(projectId?: string): Promise<CeSession[]>;
  remove(sessionId: string, projectId?: string): Promise<void>;
}

const defaultTransport: CeSessionsTransport = {
  list: (projectId) => listSessionsApi({ projectId }),
  remove: (id, projectId) => deleteSessionApi(id, projectId),
};

/**
 * Subscribe to ANY CE plugin push event (no per-session filter — any session
 * turn/question/complete should refresh the list). Returns an unsubscribe fn.
 * Default no-op = polling only, same posture as useCeSession's subscribe.
 */
export type CeSessionsSubscribe = (onAnyEvent: () => void) => () => void;

export interface UseCeSessionsOptions {
  projectId?: string;
  /** Gate fetching (mirrors useArtifacts' viewport gating). Default true. */
  enabled?: boolean;
  /** Poll interval (ms) while any session has a turn in flight. */
  pollIntervalMs?: number;
  transport?: CeSessionsTransport;
  subscribe?: CeSessionsSubscribe;
}

export interface UseCeSessionsResult {
  sessions: CeSession[];
  loading: boolean;
  error?: string;
  /** Re-fetch the list now (e.g. after launching or closing a session). */
  refresh(): Promise<void>;
  /** Discard a session and refresh the list. */
  remove(sessionId: string): Promise<void>;
}

/** Statuses with an agent turn in flight — the list keeps polling while any exist. */
const IN_FLIGHT = new Set<CeSession["status"]>(["active", "launching"]);

/**
 * Multi-session management list (server state is already multi-session: each
 * row is an independent pipeline run with its own live handle). Refreshes on
 * any plugin push event, and polls as a fallback while any session is
 * mid-turn so progress made in another tab/process still shows up.
 */
export function useCeSessions(options: UseCeSessionsOptions = {}): UseCeSessionsResult {
  const { projectId } = options;
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const transport = options.transport ?? defaultTransport;
  const subscribe = options.subscribe;

  const [sessions, setSessions] = useState<CeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await transport.list(projectId);
      if (mounted.current) {
        setSessions(next);
        setError(undefined);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [transport, projectId]);

  // Initial fetch (and on project switch).
  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void refresh();
  }, [enabled, refresh]);

  // Live push: any CE event means some session changed — refresh the list.
  useEffect(() => {
    if (!enabled || !subscribe) return;
    return subscribe(() => {
      void refresh();
    });
  }, [enabled, subscribe, refresh]);

  // Poll fallback only while a turn is actually in flight somewhere.
  const anyInFlight = sessions.some((s) => IN_FLIGHT.has(s.status));
  useEffect(() => {
    if (!enabled || !anyInFlight) return;
    const timer = setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, anyInFlight, pollIntervalMs, refresh]);

  const remove = useCallback(
    async (sessionId: string) => {
      try {
        await transport.remove(sessionId, projectId);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
        return;
      }
      await refresh();
    },
    [transport, projectId, refresh],
  );

  return { sessions, loading, error, refresh, remove };
}
