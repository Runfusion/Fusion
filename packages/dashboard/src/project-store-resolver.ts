/**
 * Project-scoped TaskStore resolver for the dashboard server.
 *
 * Caches TaskStore instances by projectId so that SSE subscriptions
 * and API route handlers for the same project share a single in-memory
 * EventEmitter. Without this cache, every call to
 * `TaskStore.getOrCreateForProject()` creates an independent TaskStore
 * with its own EventEmitter — mutations on one instance would never
 * reach SSE listeners on another, breaking real-time dashboard updates
 * for project-scoped views.
 *
 * Usage:
 *   import { getOrCreateProjectStore } from "./project-store-resolver.js";
 *   const store = await getOrCreateProjectStore(projectId);
 */

import { countRunningAgentTasks, type TaskStore } from "@fusion/core";

/**
 * Internal cache: projectId → TaskStore instance.
 * Keyed by projectId (not project path) because the dashboard server
 * routes identify projects by their central-registry ID.
 */
const storeCache = new Map<string, TaskStore>();

/**
 * In-flight creation promises, keyed by projectId.
 * Prevents concurrent requests from creating duplicate store instances
 * before the first creation completes and is added to storeCache.
 */
const pendingCreations = new Map<string, Promise<TaskStore>>();

/**
 * Track which stores have been fully initialized for real-time operation
 * (watcher started). This prevents duplicate watch() calls on repeated
 * lookups.
 */
const initializedProjects = new Set<string>();
/**
 * FNXC:RuntimeStartupWiring 2026-06-24-10:10:
 * Backend shutdown handles for stores booted via createTaskStoreForBackend.
 * Keyed by projectId so eviction can release the connection pool AND stop an
 * embedded PostgreSQL process (if one was started). The TaskStore.close()
 * call in evictProjectStore already closes the AsyncDataLayer pool; this map
 * adds the embedded-cluster teardown that the layer does not own.
 */
const backendShutdowns = new Map<string, () => Promise<void>>();
const evictionRequested = new Set<string>();
let evictAllInProgress = false;
const projectRegisteredListeners = new Set<(projectId: string, store: TaskStore) => void>();

/**
 * Optional callback invoked once when a new project store is first created.
 * Used by the dashboard server to lazily start an engine for secondary projects.
 */
let _onProjectFirstCreated: ((projectId: string) => void) | undefined;

/**
 * Register a callback to be called once when a new project is first accessed.
 * The callback fires after the store is cached — exactly once per projectId.
 * Pass `undefined` to clear the callback.
 */
export function setOnProjectFirstCreated(cb: ((projectId: string) => void) | undefined): void {
  _onProjectFirstCreated = cb;
}

/**
 * Get or create a cached TaskStore for the given projectId.
 *
 * - First call for a projectId: creates, inits, and caches the store.
 *   Also starts the SQLite polling watcher so external changes (CLI,
 *   engine agents) are detected and emitted as events.
 * - Subsequent calls: returns the cached instance immediately.
 *
 * Concurrent calls for the same projectId are deduplicated via a pending
 * promise map, preventing the race condition where the SSE endpoint and
 * an API mutation request both miss the cache and create separate store
 * instances with independent EventEmitters.
 *
 * @param projectId - The central-registry project ID
 * @returns A shared TaskStore instance for this project
 */
export async function getOrCreateProjectStore(projectId: string): Promise<TaskStore> {
  if (evictAllInProgress || evictionRequested.has(projectId)) {
    throw new Error(`Project store ${projectId} is shutting down`);
  }
  const cached = storeCache.get(projectId);
  if (cached) {
    return cached;
  }

  // Deduplicate concurrent creation requests so SSE and API routes always
  // share the same store instance even when both call this before the first
  // creation completes.
  const pending = pendingCreations.get(projectId);
  if (pending) {
    return pending;
  }

  const creation = (async () => {
    const { createTaskStoreForBackend } = await import("@fusion/core");

    // FNXC:BackendFlip 2026-06-26-14:40:
    // Consult the startup factory to boot a PostgreSQL-backed TaskStore for
    // this project. Post default-flip: the factory boots embedded PG by
    // default when DATABASE_URL is unset, external PG when DATABASE_URL is
    // set. The factory applies the schema baseline and integrates the
    // dual-read harness when FUSION_DUAL_READ=1.
    const backendBoot = await createTaskStoreForBackend({ projectId });
    // FNXC:PostgresFinalCutover 2026-07-14-17:20: Project-scoped dashboard
    // stores are always factory-backed PostgreSQL stores.
    const store = backendBoot.taskStore;
    backendShutdowns.set(projectId, backendBoot.shutdown);
    try {
      // Start watching for external changes (CLI, engine agents, etc.)
      // so SSE listeners receive live events even when mutations happen
      // outside this process.
      if (!initializedProjects.has(projectId)) {
        await store.watch();
        initializedProjects.add(projectId);
      }
      if (evictAllInProgress || evictionRequested.has(projectId)) {
        throw new Error(`Project store ${projectId} was evicted during creation`);
      }
      storeCache.set(projectId, store);
    } catch (error) {
      /* FNXC:PostgresResourceLifecycle 2026-07-14-18:04: A project store whose watcher fails never enters the cache, so resolver-owned backend resources must be shut down on the rejected creation path. */
      initializedProjects.delete(projectId);
      backendShutdowns.delete(projectId);
      storeCache.delete(projectId);
      try {
        store.stopWatching();
        await Promise.resolve(store.close());
      } catch {
        // The startup-factory shutdown below remains the authoritative cleanup.
      }
      await backendBoot.shutdown().catch(() => undefined);
      throw error;
    } finally {
      pendingCreations.delete(projectId);
    }

    // Notify once that a new project was first accessed
    if (_onProjectFirstCreated) {
      _onProjectFirstCreated(projectId);
    }

    for (const listener of projectRegisteredListeners) {
      listener(projectId, store);
    }

    return store;
  })();

  pendingCreations.set(projectId, creation);
  return creation;
}

/**
 * Remove a cached store and stop its watcher.
 * Useful for cleanup on project removal or server shutdown.
 */
export async function evictProjectStore(projectId: string): Promise<void> {
  /*
  FNXC:PostgresResourceLifecycle 2026-07-14-18:42:
  Eviction is an awaited barrier. Mark the project before waiting for an in-flight factory boot so that boot cannot insert a late cache entry, then capture/delete the shutdown handle before invocation to guarantee exactly-once backend ownership across concurrent cleanup paths.
  */
  evictionRequested.add(projectId);
  try {
    const pending = pendingCreations.get(projectId);
    if (pending) await pending.catch(() => undefined);

    const store = storeCache.get(projectId);
    storeCache.delete(projectId);
    initializedProjects.delete(projectId);
    if (store) {
      try {
        store.stopWatching();
        await Promise.resolve(store.close());
      } catch {
        // Backend shutdown still runs even when watcher/store cleanup fails.
      }
    }

    const backendShutdown = backendShutdowns.get(projectId);
    backendShutdowns.delete(projectId);
    if (backendShutdown) await backendShutdown().catch(() => undefined);
  } finally {
    evictionRequested.delete(projectId);
  }
}

/**
 * Evict all cached stores. Used during server shutdown.
 */
export async function evictAllProjectStores(): Promise<void> {
  evictAllInProgress = true;
  try {
    const pendingIds = [...pendingCreations.keys()];
    for (const projectId of pendingIds) evictionRequested.add(projectId);
    await Promise.allSettled([...pendingCreations.values()]);
    const projectIds = new Set([
      ...pendingIds,
      ...storeCache.keys(),
      ...backendShutdowns.keys(),
    ]);
    await Promise.all([...projectIds].map((projectId) => evictProjectStore(projectId)));
  } finally {
    pendingCreations.clear();
    evictionRequested.clear();
    evictAllInProgress = false;
  }
}

/**
 * Invalidate the global settings cache in all cached project stores.
 *
 * Each project-specific TaskStore holds its own GlobalSettingsStore with an
 * in-memory cache. When global settings are updated via the main store (e.g.,
 * PUT /settings/global), the file on disk is updated but the per-project
 * caches remain stale. Calling this function forces the next getSettings()
 * call in each project store to re-read from disk.
 */
export function invalidateAllGlobalSettingsCaches(): void {
  for (const store of storeCache.values()) {
    store.getGlobalSettingsStore().invalidateCache();
  }
}

export function listRegisteredProjectStores(): Array<{ projectId: string; store: TaskStore }> {
  return Array.from(storeCache.entries(), ([projectId, store]) => ({ projectId, store }));
}

/**
 * FNXC:GlobalConcurrencyControls 2026-06-26-18:20:
 * The live running-agent count must include every top-level slot holder: in-progress executors, active triage planners, and active in-review reviewer/merger/fix agents. Delegate to the shared core predicate so the footer and Command Center cannot under-count in-review work.
 */
export async function countRunningAgentsInStore(store: TaskStore): Promise<number> {
  const tasks = await store.listTasks({ slim: true });
  return countRunningAgentTasks(tasks);
}

/**
 * FNXC:GlobalConcurrencyControls 2026-06-26-17:22:
 * The dashboard live-count source is restricted to already-open project stores so global concurrency reads never open a project, start a watcher, or start an engine/runtime just to answer currently-active counts.
 */
export async function countRunningAgentsInRegisteredProjectStores(projectIds: readonly string[]): Promise<Record<string, number>> {
  const requestedProjectIds = new Set(projectIds);
  const counts: Record<string, number> = {};

  await Promise.all(listRegisteredProjectStores().map(async ({ projectId, store }) => {
    if (!requestedProjectIds.has(projectId)) {
      return;
    }

    counts[projectId] = await countRunningAgentsInStore(store);
  }));

  return counts;
}

export function onProjectStoreRegistered(listener: (projectId: string, store: TaskStore) => void): () => void {
  projectRegisteredListeners.add(listener);
  return () => {
    projectRegisteredListeners.delete(listener);
  };
}
