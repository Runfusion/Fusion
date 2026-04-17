import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAuthStatus } from "../api";
import type { AuthProvider } from "../api";

export interface SetupReadiness {
  /** True if at least one AI provider is authenticated */
  hasAiProvider: boolean;
  /** True if GitHub is connected */
  hasGithub: boolean;
  /** True if still loading auth status */
  loading: boolean;
  /** Whether any warnings should be shown (at least one setup item incomplete) */
  hasWarnings: boolean;
}

interface SetupReadinessSnapshot {
  hasAiProvider: boolean;
  hasGithub: boolean;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const setupReadinessCache = new Map<string, SetupReadinessSnapshot>();
const setupReadinessInFlight = new Map<string, Promise<SetupReadinessSnapshot>>();

function getCacheKey(projectId?: string): string {
  return projectId ?? "default";
}

function getFreshSnapshot(cacheKey: string): SetupReadinessSnapshot | null {
  const cached = setupReadinessCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (Date.now() >= cached.expiresAt) {
    setupReadinessCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function evaluateProviders(providers: AuthProvider[]): Pick<SetupReadinessSnapshot, "hasAiProvider" | "hasGithub"> {
  const hasAiProvider = providers.some((provider) => provider.id !== "github" && provider.authenticated);
  const hasGithub = providers.some((provider) => provider.id === "github" && provider.authenticated);

  return {
    hasAiProvider,
    hasGithub,
  };
}

async function fetchAndCacheSetupReadiness(cacheKey: string): Promise<SetupReadinessSnapshot> {
  const existingRequest = setupReadinessInFlight.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = fetchAuthStatus()
    .then(({ providers }) => {
      const computed = evaluateProviders(providers);
      const snapshot: SetupReadinessSnapshot = {
        ...computed,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
      setupReadinessCache.set(cacheKey, snapshot);
      return snapshot;
    })
    .finally(() => {
      setupReadinessInFlight.delete(cacheKey);
    });

  setupReadinessInFlight.set(cacheKey, request);
  return request;
}

/**
 * Clears setup-readiness cache and in-flight requests.
 * Exported for tests.
 */
export function __test_clearCache(): void {
  setupReadinessCache.clear();
  setupReadinessInFlight.clear();
}

export function useSetupReadiness(projectId?: string): SetupReadiness {
  const cacheKey = getCacheKey(projectId);
  const initialSnapshot = getFreshSnapshot(cacheKey);

  const [hasAiProvider, setHasAiProvider] = useState(initialSnapshot?.hasAiProvider ?? false);
  const [hasGithub, setHasGithub] = useState(initialSnapshot?.hasGithub ?? false);
  const [loading, setLoading] = useState(initialSnapshot == null);

  const initialLoadCompleteRef = useRef(Boolean(initialSnapshot));

  useEffect(() => {
    let cancelled = false;
    const nextCacheKey = getCacheKey(projectId);
    const cached = getFreshSnapshot(nextCacheKey);

    if (cached) {
      setHasAiProvider(cached.hasAiProvider);
      setHasGithub(cached.hasGithub);
      setLoading(false);
      initialLoadCompleteRef.current = true;
      return () => {
        cancelled = true;
      };
    }

    initialLoadCompleteRef.current = false;

    async function load(): Promise<void> {
      const isInitialLoad = !initialLoadCompleteRef.current;
      if (isInitialLoad) {
        setLoading(true);
      }

      try {
        const snapshot = await fetchAndCacheSetupReadiness(nextCacheKey);
        if (cancelled) {
          return;
        }
        setHasAiProvider(snapshot.hasAiProvider);
        setHasGithub(snapshot.hasGithub);
      } catch {
        // Best effort only: keep warnings visible when status cannot be fetched.
      } finally {
        if (!cancelled) {
          initialLoadCompleteRef.current = true;
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return useMemo(
    () => ({
      hasAiProvider,
      hasGithub,
      loading,
      hasWarnings: !hasAiProvider || !hasGithub,
    }),
    [hasAiProvider, hasGithub, loading],
  );
}
