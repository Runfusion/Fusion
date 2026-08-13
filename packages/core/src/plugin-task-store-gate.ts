import type { TaskStore } from "./store.js";
import type { PluginPermissions } from "./plugins/plugin-types.js";

/*
FNXC:PluginTaskStoreGate 2026-07-26-12:20:
PluginContext.taskStore historically handed every plugin the FULL TaskStore, so any
plugin could delete tasks, bypass failed pre-merge review steps, or bulk-archive the
board with no gate. This module is the smallest honest gate: a Proxy over the store
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
 * - `archiveAllDone` — the bulk archive sweep (archiveAllDone-style bulk method).
 * - `cleanupArchivedTasks` — bulk destructive removal of archived task history.
 * Single-task `archiveTask` is intentionally NOT denylisted: it is reversible via
 * `unarchiveTask` and gating it would break benign board-hygiene plugins.
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
  "archiveAllDone",
  "cleanupArchivedTasks",
  "getDatabase",
] as const;

export type PluginDestructiveTaskStoreMethod =
  (typeof PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS)[number];

/*
FNXC:PluginTaskStoreGate 2026-08-09-03:04:
DENY-BY-DEFAULT (U5 step 4, R14). The gate was a DENYLIST: 8 named methods blocked, everything else
on a 299-method TaskStore passing through via `Reflect.get`. That inverts the security default —
every method added to TaskStore since was silently plugin-callable, and `pluginId` was used only in
the throw message, never to decide anything.

The surface splits by risk rather than by hand-enumerating all 299, because a hand-maintained
allowlist of ~180 write methods rots immediately and its rot is invisible:

  - READS pass (see {@link isPluginReadableTaskStoreMember}). They are the bulk of legitimate plugin
    use and cannot corrupt state.
  - WRITES are denied unless listed in {@link PLUGIN_ALLOWED_WRITE_METHODS}. This is the branch that
    actually changes behavior: ~180 mutating methods that used to pass now throw.
  - DESTRUCTIVE writes still additionally require `permissions.destructiveTaskOps`.

Honest limits, so this is not mistaken for a sandbox:

1. `getAsyncLayer()` is still reachable — four in-repo plugins depend on it, and it hands out a raw
   drizzle handle that can run arbitrary SQL straight past every rule above. Migration 0059 revokes
   write on `project.actor_role_grants` from the `fusion_runtime` role that handle connects as, which
   closes the grant-yourself-a-role escalation specifically; it does NOT make the handle safe in
   general. A scoped/read-only data layer is the real fix and remains a follow-up.
2. A read can still leak. This gate governs mutation, not confidentiality.

`destructiveTaskOps` no longer returns the RAW store. It previously short-circuited the entire gate,
so the single most privileged class of plugin was the one class with no deny-by-default at all;
declaring it now widens the destructive set only.
*/

/**
 * FNXC:PluginTaskStoreGate 2026-08-09-03:04:
 * Writes a plugin may perform without declaring anything. Deliberately short, and derived from what
 * the in-repo plugins actually call — not from what seems reasonable. Every entry is a method whose
 * blast radius is a single task or the plugin's own settings, and each is reversible through the UI.
 *
 * `init`/`close` are lifecycle, not data: a plugin holding its own store handle must be able to open
 * and release it.
 *
 * Adding to this list is a security decision. Anything bulk, anything that bypasses a review gate,
 * and anything that deletes belongs in {@link PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS} instead.
 */
export const PLUGIN_ALLOWED_WRITE_METHODS: ReadonlySet<string> = new Set([
  "createTask",
  "updateTask",
  "moveTask",
  "archiveTask",
  "unarchiveTask",
  "updateSettings",
  "init",
  "close",
]);

/**
 * FNXC:PluginTaskStoreGate 2026-08-09-03:04:
 * Read classification by verb prefix. A prefix rule is used instead of a 115-entry list because the
 * list would silently fall behind every new read method, and a plugin failing on a harmless getter
 * is a bug report that costs more than it prevents.
 *
 * The prefix is not trusted blindly: `getDatabase` is read-shaped and hands out a raw SQLite handle,
 * so it stays in the destructive set and is checked BEFORE this function ever runs.
 */
export function isPluginReadableTaskStoreMember(prop: string): boolean {
  return /^(get|list|find|has|count|is|resolve|load|read|query|search|select|fetch|peek)[A-Z]?/.test(prop);
}

/**
 * FNXC:PluginTaskStoreGate 2026-08-09-03:04:
 * Language intrinsics, never gated. These are how JavaScript itself interrogates an object, not
 * plugin API: denying `toString` replaces it with a thrower, so `String(store)` and every template
 * literal or log line containing the store throw an authorization error from code that never called
 * a store method. Caught by the awaitable/inspectable test — the failure surfaces nowhere near its
 * cause, which is exactly why it is pinned.
 *
 * `hasOwnProperty` / `isPrototypeOf` are not listed because the read-prefix rule already admits them.
 */
const OBJECT_INTRINSIC_MEMBERS: ReadonlySet<string> = new Set([
  "toString",
  "toLocaleString",
  "valueOf",
  "constructor",
  "inspect",
]);

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
  const destructive = new Set<PropertyKey>(PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS);
  const destructiveDeclared = options.permissions?.destructiveTaskOps === true;
  const boundMethodCache = new Map<PropertyKey, unknown>();

  const deny = (prop: PropertyKey, hint: string): (() => never) => {
    return () => {
      throw new Error(
        `Plugin ${options.pluginId} is not permitted to call ${String(prop)}; ${hint}`,
      );
    };
  };

  return new Proxy(store, {
    get(target, prop) {
      /*
      FNXC:PluginTaskStoreGate 2026-08-09-03:04:
      Symbols pass through untouched and are never gated. They are not plugin API — they are how the
      language and the runtime interrogate the object (`Symbol.toStringTag`, `Symbol.iterator`,
      node's inspect hook). Gating them breaks `console.log(taskStore)` and similar in ways that look
      like unrelated bugs. The same reasoning covers `then`: returning a function for `then` makes
      the proxy look thenable, so `await`ing anything that resolves to this store would hang or
      recurse.
      */
      if (typeof prop === "symbol" || prop === "then" || OBJECT_INTRINSIC_MEMBERS.has(prop)) {
        return Reflect.get(target, prop, target);
      }

      const value = Reflect.get(target, prop, target);

      /*
      FNXC:PluginTaskStoreGate 2026-08-09-03:04:
      Only FUNCTIONS are gated. A denial is expressed by returning a thrower, so applying it to a
      data property would silently substitute a function for a value — `store.someCounter` would stop
      being 7 and start being a function that never gets called, turning a denial into corrupted data
      at the read site instead of a loud error at the call site. Data properties are reads, and reads
      pass (see the limits note above).
      */
      if (typeof value !== "function") return value;

      if (destructive.has(prop)) {
        if (!destructiveDeclared) {
          return deny(prop, "declare permissions.destructiveTaskOps in the plugin manifest");
        }
      } else if (!isPluginReadableTaskStoreMember(prop) && !PLUGIN_ALLOWED_WRITE_METHODS.has(prop)) {
        /*
        R14 deny-by-default. Reached only for a member that is neither a read, an allowed write, nor
        a declared-destructive call — i.e. one of the ~180 mutating methods no plugin has ever been
        granted. Before this branch existed, every one of them passed through.
        */
        return deny(
          prop,
          "the plugin TaskStore gate allows reads and a fixed set of writes; this method is not one " +
            "of them. If a plugin genuinely needs it, add it to PLUGIN_ALLOWED_WRITE_METHODS with a " +
            "reason rather than widening the gate",
        );
      }

      const cached = boundMethodCache.get(prop);
      if (cached) return cached;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      boundMethodCache.set(prop, bound);
      return bound;
    },
  }) as TaskStore;
}
