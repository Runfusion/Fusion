type BeforeExitCleanup = () => void;

type BeforeExitRegistry = {
  cleanups: Set<BeforeExitCleanup>;
  listener?: () => void;
};

const BEFORE_EXIT_REGISTRY_SYMBOL = Symbol.for("fusion.dashboard.beforeExit");

function getBeforeExitRegistry(): BeforeExitRegistry {
  const globalWithRegistry = globalThis as typeof globalThis & {
    [BEFORE_EXIT_REGISTRY_SYMBOL]?: BeforeExitRegistry;
  };

  globalWithRegistry[BEFORE_EXIT_REGISTRY_SYMBOL] ??= {
    cleanups: new Set<BeforeExitCleanup>(),
  };

  return globalWithRegistry[BEFORE_EXIT_REGISTRY_SYMBOL];
}

function runBeforeExitCleanups(registry: BeforeExitRegistry): void {
  for (const cleanup of Array.from(registry.cleanups)) {
    cleanup();
  }
}

/**
 * FNXC:ProcessLifecycle 2026-06-15-08:09:
 * Dashboard modules create unref'd cleanup intervals at import time, and Vitest can re-evaluate those modules while the process singleton survives.
 * Register cleanup callbacks behind one Symbol.for-backed beforeExit listener so repeated imports do not accumulate EventEmitter listeners or hide the leak with setMaxListeners appeasement.
 */
export function registerBeforeExitCleanup(cleanup: BeforeExitCleanup): void {
  const registry = getBeforeExitRegistry();
  registry.cleanups.add(cleanup);

  if (registry.listener) {
    return;
  }

  registry.listener = () => runBeforeExitCleanups(registry);
  process.on("beforeExit", registry.listener);
}

/** @internal Test-only helper for deterministic process-lifecycle assertions. */
export function __getBeforeExitCleanupCount(): number {
  return getBeforeExitRegistry().cleanups.size;
}

/** @internal Test-only helper for deterministic process-lifecycle assertions. */
export function __runBeforeExitCleanupsForTests(): void {
  runBeforeExitCleanups(getBeforeExitRegistry());
}

/** @internal Test-only helper for deterministic process-lifecycle assertions. */
export function __resetBeforeExitRegistryForTests(): void {
  const registry = getBeforeExitRegistry();
  if (registry.listener) {
    process.off("beforeExit", registry.listener);
  }
  registry.cleanups.clear();
  registry.listener = undefined;
}
