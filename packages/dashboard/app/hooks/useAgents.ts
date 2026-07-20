import { useState, useEffect, useCallback, useRef } from "react";
import type { Agent, AgentState, AgentCapability, AgentStats } from "../api";
import { fetchAgents, fetchAgentStats } from "../api";
import { isEphemeralAgent } from "@fusion/core";
import { subscribeSse } from "../sse-bus";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { useProjectContextGuard } from "./useProjectContextGuard";

interface UseAgentsOptions {
  filterState?: AgentState | "all";
  showSystemAgents?: boolean;
}

interface AgentFilter {
  state?: AgentState;
  role?: AgentCapability;
  includeEphemeral?: boolean;
}

// Debounce window for SSE-triggered refreshes. A burst of agent:updated /
// agent:stateChanged events during multi-agent activity used to fire one
// forceFresh fetch per event, defeating the dedupe layer. Coalescing inside
// this window collapses the burst into one network round trip.
const SSE_REFRESH_DEBOUNCE_MS = 250;

export function useAgents(projectId?: string, options?: UseAgentsOptions) {
  const agentsCacheKey = projectId ? `${SWR_CACHE_KEYS.AGENTS}:${projectId}` : SWR_CACHE_KEYS.AGENTS;
  const statsCacheKey = projectId ? `${SWR_CACHE_KEYS.AGENT_STATS}:${projectId}` : SWR_CACHE_KEYS.AGENT_STATS;
  const [agents, setAgents] = useState<Agent[]>(() => {
    const cached = readCache<Agent[]>(agentsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [stats, setStats] = useState<AgentStats | null>(() => {
    const cached = readCache<AgentStats>(statsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return cached ?? null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const hasCachedHydrationRef = useRef(agents.length > 0 || stats !== null);

  // Generation counters. Each loadAgents/loadStats call gets a monotonically
  // increasing id; only the latest call's response is allowed to write state.
  // This neutralizes two races at once:
  //   (a) poll-vs-mutation: if a slow poll resolves AFTER a forceFresh
  //       mutation refetch, the poll's setAgents is dropped instead of
  //       overwriting fresh post-mutation data.
  //   (b) concurrent forceFresh: if two mutations fire near-simultaneously,
  //       only the second's response updates state regardless of which HTTP
  //       response happens to arrive first (TCP/HTTP ordering is not
  //       guaranteed).
  // With this in place, callers don't need to remember to pass forceFresh
  // for correctness — the gen counter handles stale-response suppression
  // regardless. forceFresh still helps by triggering an actual fresh
  // network request, useful when mutations have already committed and the
  // caller wants the post-mutation snapshot now rather than waiting for the
  // next SSE event.
  const agentsGenRef = useRef(0);
  const statsGenRef = useRef(0);
  /*
  FNXC:ProjectScoping 2026-07-15-20:10:
  Agent snapshots and their SSE-triggered refreshes are scoped to the project
  captured at dispatch, so a stale prior-project response cannot replace B.
  */
  const { capture } = useProjectContextGuard(projectId, "useAgents");

  useEffect(() => {
    /*
    FNXC:ProjectScoping 2026-07-16-00:00:
    Agent cache hydration is keyed by project. On a project switch, clear A's
    snapshot immediately or hydrate only B's cache while B's scoped request runs.
    */
    const cachedAgents = readCache<Agent[]>(agentsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const cachedStats = readCache<AgentStats>(statsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const nextAgents = Array.isArray(cachedAgents) ? cachedAgents : [];
    const nextStats = cachedStats ?? null;
    setAgents(nextAgents);
    setStats(nextStats);
    hasCachedHydrationRef.current = nextAgents.length > 0 || nextStats !== null;
    setIsLoading(false);
  }, [agentsCacheKey, statsCacheKey]);

  const loadAgents = useCallback(async (filter?: AgentFilter, opts?: { forceFresh?: boolean }) => {
    const context = capture();
    const gen = ++agentsGenRef.current;
    if (!hasCachedHydrationRef.current) {
      setIsLoading(true);
    }
    try {
      const filterState = options?.filterState;
      const baseFilter = filterState && filterState !== "all" ? { state: filterState } : undefined;
      const includeEphemeral = options?.showSystemAgents ?? false;
      const mergedFilter = {
        ...baseFilter,
        ...filter,
        includeEphemeral: filter?.includeEphemeral ?? includeEphemeral,
      };
      const data = opts?.forceFresh
        ? await fetchAgents(mergedFilter, projectId, { forceFresh: true })
        : await fetchAgents(mergedFilter, projectId);
      // A newer call superseded us — drop this response so we don't clobber
      // fresher state with stale data.
      if (gen !== agentsGenRef.current || context.isStale()) return;
      // Defensive dedupe: a race between the initial fetch and an SSE refresh
      // (or a backend that returned the same agent twice) would otherwise put
      // duplicate ids into every list rendered from this hook, flooding React
      // with duplicate-key warnings until the dashboard runs out of heap.
      const unique = Array.from(new Map(data.map((a) => [a.id, a])).values());
      setAgents(unique);
      writeCache(agentsCacheKey, unique, { maxBytes: 500_000 });
      hasCachedHydrationRef.current = hasCachedHydrationRef.current || unique.length > 0;
    } catch (err) {
      console.error("Failed to load agents:", err);
    } finally {
      if (gen === agentsGenRef.current) setIsLoading(false);
    }
  }, [agentsCacheKey, capture, projectId, options?.filterState, options?.showSystemAgents]);

  const loadStats = useCallback(async (opts?: { forceFresh?: boolean }) => {
    const context = capture();
    const gen = ++statsGenRef.current;
    try {
      const data = opts?.forceFresh
        ? await fetchAgentStats(projectId, { forceFresh: true })
        : await fetchAgentStats(projectId);
      if (gen !== statsGenRef.current || context.isStale()) return;
      setStats(data);
      writeCache(statsCacheKey, data, { maxBytes: 500_000 });
      hasCachedHydrationRef.current = true;
    } catch (err) {
      console.error("Failed to load agent stats:", err);
    }
  }, [capture, projectId, statsCacheKey]);

  useEffect(() => {
    void loadAgents();
    void loadStats();
  }, [loadAgents, loadStats]);

  // SSE subscription for agent events. SSE events fire AFTER the backend
  // commits the mutation, so we want the post-mutation snapshot. Refresh is
  // debounced to coalesce bursts (e.g. many agent:updated events during a
  // batch operation) into a single network round trip.
  //
  // Trailing-edge guard: a naive leading-edge debounce degrades to one fetch
  // per ~250ms when sustained event bursts arrive faster than the fetch
  // completes — events that land during an in-flight fetch each schedule a
  // fresh timer. To prevent this storm: while a fetch is in-flight, mark
  // pendingDuringFetch and skip arming new timers. When the fetch settles,
  // if any events arrived during it, fire ONE more refresh to capture the
  // latest state. Net guarantee: per burst of N events arriving within a
  // fetch+debounce window, we issue at most 2 fetches (the initial debounced
  // fetch and one trailing catch-up).
  useEffect(() => {
    const context = capture();
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let fetchInProgress = false;
    let pendingDuringFetch = false;
    let unmounted = false;

    const fire = async (): Promise<void> => {
      fetchInProgress = true;
      pendingDuringFetch = false;
      try {
        await Promise.all([
          loadAgents(undefined, { forceFresh: true }),
          loadStats({ forceFresh: true }),
        ]);
      } finally {
        fetchInProgress = false;
        if (!unmounted && pendingDuringFetch) {
          // Events arrived during the fetch — run one trailing refresh to
          // capture them. Use a normal debounce so a continued burst still
          // coalesces.
          schedule();
        }
      }
    };

    const schedule = (): void => {
      if (debounceTimer || fetchInProgress) {
        if (fetchInProgress) pendingDuringFetch = true;
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fire();
      }, SSE_REFRESH_DEBOUNCE_MS);
    };

    const refresh = (): void => {
      if (context.isStale()) return;
      if (fetchInProgress) {
        // Mark a trailing refresh; don't schedule a new timer that would race
        // the in-flight fetch and (via forceFresh) discard its response.
        pendingDuringFetch = true;
        return;
      }
      schedule();
    };

    const unsubscribe = subscribeSse(`/api/events${query}`, {
      events: {
        "agent:created": refresh,
        "agent:updated": refresh,
        "agent:deleted": refresh,
        "agent:stateChanged": refresh,
        "approval:requested": refresh,
        "approval:updated": refresh,
        "approval:decided": refresh,
      },
    });

    return () => {
      unmounted = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [capture, projectId, loadAgents, loadStats]);

  // refreshAgents is the canonical post-mutation refetch entrypoint. It
  // defaults to forceFresh so consumers don't have to remember — anyone
  // calling refreshAgents() after a save/delete gets a fresh round trip,
  // never a stale in-flight pre-mutation read.
  const refreshAgents = useCallback(async () => {
    await Promise.all([
      loadAgents(undefined, { forceFresh: true }),
      loadStats({ forceFresh: true }),
    ]);
  }, [loadAgents, loadStats]);

  const showSystemAgents = options?.showSystemAgents ?? false;
  const activeAgents = agents.filter((agent) => {
    if (agent.state !== "active" && agent.state !== "running") {
      return false;
    }
    return showSystemAgents || !isEphemeralAgent(agent);
  });

  return { agents, activeAgents, stats, isLoading, loadAgents, loadStats, refreshAgents };
}
