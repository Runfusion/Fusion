import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";

type CatalogModel = (typeof KIMI_CODING_MODELS)[keyof typeof KIMI_CODING_MODELS];
type RegistryModel = CatalogModel & { provider: string };
type ProviderRegistration = { models?: readonly RegistryModel[] } & Record<string, unknown>;

/*
FNXC:ModelCatalog 2026-08-09-10:27:
FN-8900 replaces a live ModelRegistry.refresh() path that reproducibly stalled for about 300 seconds,
even with model networking disabled. This seam keeps pi-ai's actual bundled Kimi rows, so an SDK
regression that removes or renames K3 still fails route coverage, while refresh remains a no-op.
Timeouts, retries, and assertion strength remain unchanged.
*/
export function createKimiModelCatalogRegistry(options: { duplicateK3?: boolean; omitK3?: boolean } = {}) {
  const kimiModels = Object.values(KIMI_CODING_MODELS)
    .filter((model) => !options.omitK3 || model.id !== "k3")
    .map((model) => ({ ...model, provider: "kimi-coding" }));
  const k3 = KIMI_CODING_MODELS.k3;

  if (options.duplicateK3 && k3) {
    kimiModels.push({ ...k3, provider: "kimi-coding" });
  }

  const registeredProviders = new Map<string, ProviderRegistration>([
    ["kimi-coding", { models: kimiModels }],
  ]);
  const getAll = () => [...registeredProviders.entries()].flatMap(([provider, registration]) =>
    (registration.models ?? []).map((model) => ({ ...model, provider })),
  );

  return {
    registeredProviders,
    refresh: async () => undefined,
    getAll,
    getAvailable: getAll,
    registerProvider(provider: string, registration: ProviderRegistration) {
      registeredProviders.set(provider, registration);
    },
  };
}
