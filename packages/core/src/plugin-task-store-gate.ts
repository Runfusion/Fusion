import type { TaskStore } from "./store.js";
import type { PluginPermissions } from "./plugins/plugin-types.js";

/*
FNXC:PluginTaskStoreGate 2026-07-26-12:20:
PluginContext.taskStore historically handed every plugin the FULL TaskStore, so any
plugin could delete tasks or bypass failed pre-merge review steps with no gate. This module is the smallest honest gate: a Proxy over the store
that intercepts a hardcoded denylist of destructive methods and throws unless the
plugin's manifest declares `permissions: { destructiveTaskOps: true }`. Everything
not on the denylist passes through untouched, so default plugin behavior is
otherwise unchanged.
*/

/**
 * FNXC:PluginTaskStoreGate 2026-07-26-12:20:
 * Destructive-method denylist. Chosen from the TaskStore surface:
 * - `deleteTask` / `deleteTaskIf` / `deleteTaskById` / `deleteTaskBackend` — every
 *   task-deletion entry point (public and backend seams reachable via the handle).
 * - `bypassFailedPreMergeReviewStep` — the FN-7720 privileged operator bypass of a
 *   failed pre-merge review gate; must never be callable by an ungated plugin.
 * - `getDatabase` — the raw sync SQLite handle. No in-repo plugin uses it (the QA
 *   plugin explicitly documents NOT to), and a raw handle would let a plugin run
 *   destructive SQL around the named-method denylist, so it requires the same
 *   destructiveTaskOps declaration.
 *
 * FNXC:PluginTaskStoreGate 2026-07-26-18:20:
 * KNOWN RESIDUAL (review finding, deliberately not closed here): `getAsyncLayer()`
 * also exposes a raw (drizzle) handle that could execute destructive SQL outside
 * the denylist. It is NOT denied because four in-repo plugins (printing-press,
 * compound-engineering, glasses, quality) legitimately depend on it for their own
 * plugin-scoped schema/reads — denying it breaks them, and granting them
 * destructiveTaskOps to compensate would defeat the gate entirely. Making this
 * airtight needs a scoped/read-only data-layer design (a follow-up), not a
 * denylist entry. Until then the gate is an honest guard against the named
 * destructive TaskStore surface, not a sandbox for raw SQL.
 */
export const PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS = [
  "deleteTask",
  "deleteTaskIf",
  "deleteTaskById",
  "deleteTaskBackend",
  "bypassFailedPreMergeReviewStep",
  "getDatabase",
] as const;

export type PluginDestructiveTaskStoreMethod =
  (typeof PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS)[number];

export interface PluginTaskStoreGateOptions {
  pluginId: string;
  permissions?: PluginPermissions;
}

/**
 * FNXC:PluginTaskStoreGate 2026-07-26-12:20:
 * Wrap a TaskStore for hand-off to a plugin context. When the plugin manifest
 * declares `permissions.destructiveTaskOps: true` the raw store is returned
 * unchanged. Otherwise a Proxy intercepts the denylisted methods and throws a
 * clear declaration-pointing error.
 *
 * Implementation notes:
 * - Non-denylisted function properties are bound to the RAW store (and cached per
 *   property) so `this` inside store methods is always the real TaskStore. This
 *   preserves WeakMap-keyed seams (e.g. task-move-disposer registration keyed by
 *   store identity) that would silently break if methods ran with the proxy as
 *   `this`.
 * - The thrower is a plain sync function so both `store.deleteTask(...)` and
 *   `await store.deleteTask(...)` fail loudly.
 */
export function createPluginGatedTaskStore(
  store: TaskStore,
  options: PluginTaskStoreGateOptions,
): TaskStore {
  if (options.permissions?.destructiveTaskOps === true) return store;
  const denied = new Set<PropertyKey>(PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS);
  const boundMethodCache = new Map<PropertyKey, unknown>();
  return new Proxy(store, {
    get(target, prop) {
      if (denied.has(prop)) {
        return () => {
          throw new Error(
            `Plugin ${options.pluginId} is not permitted to call ${String(prop)}; ` +
              `declare permissions.destructiveTaskOps in the plugin manifest`,
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const cached = boundMethodCache.get(prop);
      if (cached) return cached;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      boundMethodCache.set(prop, bound);
      return bound;
    },
  }) as TaskStore;
}
