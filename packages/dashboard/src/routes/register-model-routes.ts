import { resolvePlanningSettingsModel } from "@fusion/core";
import { ApiError } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerModelRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, store, runtimeLogger } = ctx;

  router.get("/models", async (_req, res) => {
    // Get favoriteProviders/favoriteModels and default model from global settings.
    let favoriteProviders: string[] = [];
    let favoriteModels: string[] = [];
    let defaultProvider: string | undefined;
    let defaultModelId: string | undefined;
    let useClaudeCli = false;
    let useDroidCli = false;
    let useLlamaCpp = false;
    let resolvedPlanningProvider: string | undefined;
    let resolvedPlanningModelId: string | undefined;
    if (store) {
      try {
        const globalStore = store.getGlobalSettingsStore();
        const globalSettings = await globalStore.getSettings();
        favoriteProviders = globalSettings.favoriteProviders ?? [];
        favoriteModels = globalSettings.favoriteModels ?? [];
        defaultProvider = globalSettings.defaultProvider;
        defaultModelId = globalSettings.defaultModelId;
        useClaudeCli = globalSettings.useClaudeCli === true;
        useDroidCli = globalSettings.useDroidCli === true;
        useLlamaCpp = globalSettings.useLlamaCpp === true;

        const mergedSettings = await store.getSettingsFast();
        const resolvedPlanningModel = resolvePlanningSettingsModel(mergedSettings);
        resolvedPlanningProvider = resolvedPlanningModel.provider;
        resolvedPlanningModelId = resolvedPlanningModel.modelId;
      } catch {
        // Silently ignore settings errors - just return empty favorites/default model
      }
    }

    const defaultModelResponse =
      defaultProvider && defaultModelId
        ? { defaultProvider, defaultModelId }
        : {};
    const resolvedPlanningModelResponse =
      resolvedPlanningProvider && resolvedPlanningModelId
        ? {
            resolvedPlanningProvider,
            resolvedPlanningModelId,
          }
        : {};

    // Always return 200 with empty array instead of 404 when no models available.
    // This ensures the frontend can handle empty states gracefully.
    if (!options?.modelRegistry) {
      res.json({
        models: [],
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
      return;
    }

    try {
      options.modelRegistry.refresh();
      let models = options.modelRegistry.getAvailable().map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
      }));

      // The vendored pi-claude-cli extension registers its provider as
      // "pi-claude-cli" (distinct from "anthropic") whenever it loads.
      // When the toggle is OFF, hide those entries from pickers so users
      // don't see CLI-routed models they haven't opted into. When ON,
      // surface everything so the CLI-routed entries appear alongside any
      // direct provider auth the user has connected.
      if (!useClaudeCli) {
        models = models.filter((m) => m.provider !== "pi-claude-cli");
      }
      if (!useDroidCli) {
        models = models.filter((m) => m.provider !== "droid-cli");
      }
      if (!useLlamaCpp) {
        models = models.filter((m) => m.provider !== "llama-server");
      }

      res.json({
        models,
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      runtimeLogger.child("models").warn(`Failed to load models: ${message}`);
      res.json({
        models: [],
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
    }
  });
};
