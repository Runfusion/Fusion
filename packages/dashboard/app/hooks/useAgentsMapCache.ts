import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgents, type Agent } from "../api";
import { clearCache, readCache, SWR_CACHE_KEYS, SWR_TASKS_MAX_AGE_MS, writeCache } from "../utils/swrCache";

export interface UseAgentsMapCacheResult {
  agentsMap: Map<string, Agent>;
  agents: Agent[];
  loading: boolean;
  refresh: () => Promise<void>;
}

const inflightByProject = new Map<string, Promise<Agent[]>>();
const listenersByProject = new Map<string, Set<(agents: Agent[]) => void>>();

function getProjectKey(projectId?: string): string {
  return projectId ?? "global";
}

function getCacheKey(projectId?: string): string {
  return `${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}${getProjectKey(projectId)}`;
}

function readCachedAgents(projectId?: string): Agent[] | null {
  return readCache<Agent[]>(getCacheKey(projectId), { maxAgeMs: SWR_TASKS_MAX_AGE_MS });
}

function notifyListeners(projectKey: string, agents: Agent[]): void {
  for (const listener of listenersByProject.get(projectKey) ?? []) {
    listener(agents);
  }
}

async function fetchSharedAgents(projectId?: string): Promise<Agent[]> {
  const projectKey = getProjectKey(projectId);
  const existing = inflightByProject.get(projectKey);
  if (existing) {
    return existing;
  }

  const request = fetchAgents(undefined, projectId).finally(() => {
    inflightByProject.delete(projectKey);
  });
  inflightByProject.set(projectKey, request);
  return request;
}

/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 added the OPTIONAL `enabled` flag, defaulting to true, so a read-only consumer (the header
 * search result card) can be inert without changing any existing consumer. `NewTaskModal`, `ChatView`,
 * `useChat`, and `ProjectModelsSection` pass no options and therefore behave exactly as before.
 *
 * Disabled means inert at BOTH ends: no fetch, no shared-listener registration, and no cache READ.
 * The read matters on its own — a task id is unique only within a project, so a cached entry from the
 * viewer's own project would otherwise be painted onto a remote node's task with the same id.
 */
export interface UseAgentsMapCacheOptions {
  enabled?: boolean;
}

export function useAgentsMapCache(projectId?: string, options?: UseAgentsMapCacheOptions): UseAgentsMapCacheResult {
  const enabled = options?.enabled ?? true;
  const [agents, setAgents] = useState<Agent[]>(() => enabled ? readCachedAgents(projectId) ?? [] : []);
  const [loading, setLoading] = useState(() => enabled ? readCachedAgents(projectId) === null : false);
  const hasCachedStateRef = useRef(enabled ? readCachedAgents(projectId) !== null : false);
  const projectKey = getProjectKey(projectId);

  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setLoading(false);
      hasCachedStateRef.current = false;
      return;
    }
    const cachedAgents = readCachedAgents(projectId) ?? [];
    setAgents(cachedAgents);
    setLoading(readCachedAgents(projectId) === null);
    hasCachedStateRef.current = readCachedAgents(projectId) !== null;
  }, [enabled, projectId]);

  useEffect(() => {
    if (!enabled) return;
    const listeners = listenersByProject.get(projectKey) ?? new Set<(agents: Agent[]) => void>();
    listeners.add(setAgents);
    listenersByProject.set(projectKey, listeners);
    return () => {
      listeners.delete(setAgents);
      if (listeners.size === 0) {
        listenersByProject.delete(projectKey);
      }
    };
  }, [enabled, projectKey]);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const nextAgents = await fetchSharedAgents(projectId);
      hasCachedStateRef.current = true;
      writeCache(getCacheKey(projectId), nextAgents, { maxBytes: 500_000 });
      notifyListeners(projectKey, nextAgents);
    } catch {
      if (!hasCachedStateRef.current) {
        clearCache(getCacheKey(projectId));
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, projectId, projectKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    await load();
  }, [enabled, load]);

  const agentsMap = useMemo(() => {
    const nextMap = new Map<string, Agent>();
    for (const agent of agents) {
      nextMap.set(agent.id, agent);
    }
    return nextMap;
  }, [agents]);

  return { agentsMap, agents, loading, refresh };
}
