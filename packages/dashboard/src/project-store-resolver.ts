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

import type { TaskStore } from "@fusion/core";

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
    const { TaskStore: TaskStoreClass } = await import("@fusion/core");
    const store = await TaskStoreClass.getOrCreateForProject(projectId);

    // Start watching for external changes (CLI, engine agents, etc.)
    // so SSE listeners receive live events even when mutations happen
    // outside this process.
    if (!initializedProjects.has(projectId)) {
      initializedProjects.add(projectId);
      await store.watch();
    }

    storeCache.set(projectId, store);
    pendingCreations.delete(projectId);

    // Notify once that a new project was first accessed
    if (_onProjectFirstCreated) {
      _onProjectFirstCreated(projectId);
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
export function evictProjectStore(projectId: string): void {
  pendingCreations.delete(projectId);
  const store = storeCache.get(projectId);
  if (store) {
    store.stopWatching();
    store.close();
    storeCache.delete(projectId);
    initializedProjects.delete(projectId);
  }
}

/**
 * Evict all cached stores. Used during server shutdown.
 */
export function evictAllProjectStores(): void {
  pendingCreations.clear();
  for (const projectId of storeCache.keys()) {
    evictProjectStore(projectId);
  }
}
