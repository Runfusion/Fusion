/*
FNXC:ModelRegistry 2026-07-21-17:15:
pi 0.80.8+ ModelRegistry.refresh() delegates to ModelRuntime.reloadConfig() /
refresh(), which performs remote model-catalog fetches and availability checks
with no timeout on the post-create path. A hung provider catalog (observed as a
stuck HTTPS connection to Cloudflare while the TUI stayed on "Loading
extensions…") blocked fn dashboard / serve / daemon forever after extensions
had already finished loading. Bound every Fusion-owned await so startup always
progresses; createFusionModelRegistry already ran a 15s network refresh and
cached models remain usable.
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_REGISTRY_REFRESH_TIMEOUT_MS;
  const allowNetwork = options.allowNetwork ?? true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const runtime = modelRegistry.modelRuntime;
    const work = runtime
      ? runtime.refresh({ allowNetwork, signal: controller.signal })
      : Promise.resolve(modelRegistry.refresh());

    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(new Error(`Model registry refresh timed out after ${timeoutMs}ms`));
        };
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    return "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = controller.signal.aborted || /timed out/i.test(message);
    if (timedOut) {
      options.log?.(
        `Model registry refresh timed out after ${timeoutMs}ms; continuing with cached models`,
      );
      return "timed_out";
    }
    options.log?.(`Model registry refresh failed: ${message}`);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
