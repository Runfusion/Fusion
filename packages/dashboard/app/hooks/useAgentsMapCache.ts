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

export function useAgentsMapCache(projectId?: string): UseAgentsMapCacheResult {
  const [agents, setAgents] = useState<Agent[]>(() => readCachedAgents(projectId) ?? []);
  const [loading, setLoading] = useState(() => readCachedAgents(projectId) === null);
  const hasCachedStateRef = useRef(readCachedAgents(projectId) !== null);
  const projectKey = getProjectKey(projectId);

  useEffect(() => {
    const cachedAgents = readCachedAgents(projectId) ?? [];
    setAgents(cachedAgents);
    setLoading(readCachedAgents(projectId) === null);
    hasCachedStateRef.current = readCachedAgents(projectId) !== null;
  }, [projectId]);

  useEffect(() => {
    const listeners = listenersByProject.get(projectKey) ?? new Set<(agents: Agent[]) => void>();
    listeners.add(setAgents);
    listenersByProject.set(projectKey, listeners);
    return () => {
      listeners.delete(setAgents);
      if (listeners.size === 0) {
        listenersByProject.delete(projectKey);
      }
    };
  }, [projectKey]);

  const load = useCallback(async () => {
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
  }, [projectId, projectKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await load();
  }, [load]);

  const agentsMap = useMemo(() => {
    const nextMap = new Map<string, Agent>();
    for (const agent of agents) {
      nextMap.set(agent.id, agent);
    }
    return nextMap;
  }, [agents]);

  return { agentsMap, agents, loading, refresh };
}
