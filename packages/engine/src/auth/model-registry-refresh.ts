/*
FNXC:ModelRegistry 2026-08-12-01:00:
ModelRegistry.refresh() can leave an uncancellable provider-catalog operation running after its
bounded await expires. FN-8902 exposes that one underlying promise so request-path callers can
retain single-flight ownership and apply later waits only for their remaining budget, rather than
starting concurrent catalog reloads. On the ModelRuntime path the first bound abort can reject the
underlying promise; consumers must account for that as a failed late settlement, never a refresh.
*/

/** Default bound for Fusion-owned model-registry refresh awaits (matches ModelRuntime.create). */
export const DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS = 15_000;

export type ModelRegistryRefreshOutcome = "completed" | "timed_out" | "failed";

export type RefreshableModelRegistry = {
  refresh: () => unknown;
  modelRuntime?: {
    refresh: (options?: {
      allowNetwork?: boolean;
      signal?: AbortSignal;
      force?: boolean;
    }) => Promise<unknown>;
  };
};

export type RefreshFusionModelRegistryOptions = {
  timeoutMs?: number;
  /** When runtime is available, pass through to ModelRuntime.refresh. Default true. */
  allowNetwork?: boolean;
  log?: (message: string) => void;
};

/** Options for bounding a refresh that has already been started. */
export type BoundExistingModelRegistryRefreshOptions = Pick<RefreshFusionModelRegistryOptions, "timeoutMs" | "log">;

function refreshTimeoutError(timeoutMs: number): Error {
  return new Error(`Model registry refresh timed out after ${timeoutMs}ms`);
}

async function boundModelRegistryRefresh(
  underlying: Promise<unknown>,
  options: BoundExistingModelRegistryRefreshOptions,
  controller?: AbortController,
): Promise<ModelRegistryRefreshOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      reject(refreshTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    await Promise.race([underlying, timeout]);
    return "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut || controller?.signal.aborted || /timed out/i.test(message)) {
      options.log?.(`Model registry refresh timed out after ${timeoutMs}ms; continuing with cached models`);
      return "timed_out";
    }
    options.log?.(`Model registry refresh failed: ${message}`);
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Apply Fusion's wall-clock outcome mapping to an already-running refresh.
 * This intentionally creates no AbortSignal: only the original starter can
 * signal a ModelRuntime operation, and registry.refresh() cannot be cancelled.
 */
export function boundExistingModelRegistryRefresh(
  underlying: Promise<unknown>,
  options: BoundExistingModelRegistryRefreshOptions = {},
): Promise<ModelRegistryRefreshOutcome> {
  return boundModelRegistryRefresh(underlying, options);
}

/**
 * Start exactly one registry refresh and expose both its faithful underlying
 * promise and its bounded outcome. A retained catch prevents a late rejection
 * from becoming unhandled when callers only await `bounded`.
 */
export function startFusionModelRegistryRefresh(
  modelRegistry: RefreshableModelRegistry,
  options: RefreshFusionModelRegistryOptions = {},
): { underlying: Promise<unknown>; bounded: Promise<ModelRegistryRefreshOutcome> } {
  const controller = new AbortController();
  const allowNetwork = options.allowNetwork ?? true;
  const runtime = modelRegistry.modelRuntime;
  const underlying = typeof runtime?.refresh === "function"
    ? Promise.resolve().then(() => runtime.refresh({ allowNetwork, signal: controller.signal }))
    : Promise.resolve().then(() => modelRegistry.refresh());

  // Keep a rejection observed independently of the bounded race without changing
  // the promise returned to callers that need its original settlement.
  void underlying.catch(() => {});
  return {
    underlying,
    bounded: boundModelRegistryRefresh(underlying, options, controller),
  };
}

/**
 * Await a model-registry refresh with a hard wall-clock bound.
 * Prefers ModelRuntime.refresh({ signal }) when present so in-flight catalog
 * fetches can abort; always races the full operation because forceRefreshAvailability
 * inside ModelRuntime.refresh does not honor AbortSignal.
 */
export async function refreshFusionModelRegistry(
  modelRegistry: RefreshableModelRegistry,
  options: RefreshFusionModelRegistryOptions = {},
): Promise<ModelRegistryRefreshOutcome> {
  return startFusionModelRegistryRefresh(modelRegistry, options).bounded;
}
