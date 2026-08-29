import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDiscoveredSkills, type DiscoveredSkill } from "../api";
import { clearCache, readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";

export interface UseDiscoveredSkillsCacheResult {
  skills: DiscoveredSkill[];
  loading: boolean;
  /** True when discovery could not refresh; consumers must not infer undiscovered IDs. */
  error: boolean;
  refresh: () => Promise<void>;
}

const inflightByProject = new Map<string, Promise<DiscoveredSkill[]>>();
const listenersByProject = new Map<string, Set<(skills: DiscoveredSkill[]) => void>>();

function getProjectKey(projectId?: string): string {
  return projectId ?? "global";
}

function getCacheKey(projectId?: string): string {
  return `${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}${getProjectKey(projectId)}`;
}

function readCachedSkills(projectId?: string): DiscoveredSkill[] | null {
  return readCache<DiscoveredSkill[]>(getCacheKey(projectId), { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
}

function notifyListeners(projectKey: string, skills: DiscoveredSkill[]): void {
  for (const listener of listenersByProject.get(projectKey) ?? []) {
    listener(skills);
  }
}

async function fetchSharedSkills(projectId?: string): Promise<DiscoveredSkill[]> {
  const projectKey = getProjectKey(projectId);
  const existing = inflightByProject.get(projectKey);
  if (existing) {
    return existing;
  }

  const request = fetchDiscoveredSkills(projectId).finally(() => {
    inflightByProject.delete(projectKey);
  });
  inflightByProject.set(projectKey, request);
  return request;
}

export function useDiscoveredSkillsCache(projectId?: string): UseDiscoveredSkillsCacheResult {
  const [skills, setSkills] = useState<DiscoveredSkill[]>(() => readCachedSkills(projectId) ?? []);
  const [loading, setLoading] = useState(() => readCachedSkills(projectId) === null);
  const [error, setError] = useState(false);
  const hasCachedStateRef = useRef(readCachedSkills(projectId) !== null);
  const projectKey = getProjectKey(projectId);

  useEffect(() => {
    const cachedSkills = readCachedSkills(projectId) ?? [];
    setSkills(cachedSkills);
    setLoading(readCachedSkills(projectId) === null);
    setError(false);
    hasCachedStateRef.current = readCachedSkills(projectId) !== null;
  }, [projectId]);

  useEffect(() => {
    const listeners = listenersByProject.get(projectKey) ?? new Set<(skills: DiscoveredSkill[]) => void>();
    listeners.add(setSkills);
    listenersByProject.set(projectKey, listeners);
    return () => {
      listeners.delete(setSkills);
      if (listeners.size === 0) {
        listenersByProject.delete(projectKey);
      }
    };
  }, [projectKey]);

  const load = useCallback(async () => {
    try {
      const nextSkills = await fetchSharedSkills(projectId);
      hasCachedStateRef.current = true;
      setError(false);
      writeCache(getCacheKey(projectId), nextSkills, { maxBytes: 500_000 });
      notifyListeners(projectKey, nextSkills);
    } catch {
      /*
       * FNXC:AgentSkillsUI 2026-08-16-04:42:
       * A failed discovery request cannot prove a stored skill disappeared. Expose the failure so
       * badge renderers retain their neutral pending classification until discovery succeeds.
       */
      setError(true);
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

  return { skills, loading, error, refresh };
}
