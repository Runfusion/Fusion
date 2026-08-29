import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/*
FNXC:ModelCatalog 2026-08-01-08:14:
FN-8670 moves real Pi SDK catalog construction out of timed test bodies into beforeAll. The runtime is
memoized per test file because Vitest file-level isolation gives each file its own module graph.
ModelRegistry.registerProvider writes into its shared ModelRuntime, so each handed-out registry clears
prior extension providers before use. The SDK remains real, not stubbed, because this coverage catches
catalog regressions such as FN-8564's native Kimi K3; widening timeouts or adding retries is forbidden here.
*/
let sharedModelRuntime: Promise<ModelRuntime> | undefined;

export function getSharedModelRuntime(): Promise<ModelRuntime> {
  sharedModelRuntime ??= ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_id, fn) => fn(undefined),
      delete: async () => undefined,
    },
    modelsPath: null,
    allowModelNetwork: false,
  });
  return sharedModelRuntime;
}

export async function warmSharedModelRuntime(): Promise<void> {
  await getSharedModelRuntime();
}

export async function createInMemoryModelRegistry(): Promise<ModelRegistry> {
  const modelRegistry = new ModelRegistry(await getSharedModelRuntime());

  for (const providerId of modelRegistry.getRegisteredProviderIds()) {
    modelRegistry.unregisterProvider(providerId);
  }
  await modelRegistry.refresh();

  return modelRegistry;
}
