/**
 * Search entries for the Global Models section.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * One entry per descriptor row the section renders, co-located so a setting and its index entry change in the same edit. Labels and help mirror the section's `t()` calls verbatim: the index matches on the copy operators actually read, so a paraphrase here would make search miss the words on screen.
 * Every OpenRouter advanced row is indexed even though the section renders them inside a collapsed <details>: search's whole purpose is finding a control an operator cannot see, and these are the ones most likely to be hunted by their stored field name (openrouterProviderPreferences.sort) rather than by browsing.
 * Absent by design: the Default/Fallback model pickers and the per-role model lanes (bespoke CustomModelDropdown widgets), the model pricing table this section mounts, and the opencode-go sync toggle, which stays hand-rolled for its <code> help markup and so has no descriptor key to anchor a result to.
 */
import type { SettingsSearchEntry } from "../search/types";

export const globalModelsSearchEntries: SettingsSearchEntry[] = [
  {
    sectionId: "global-models",
    key: "defaultThinkingLevel",
    labelKey: "settings.globalModels.thinkingEffort",
    labelFallback: "Thinking Effort",
    helpKey: "settings.globalModels.controlsHowMuchReasoningEffortTheAIModel",
    helpFallback:
      "Controls how much reasoning effort the AI model uses. Higher levels produce better results but cost more. No default — unset (model's own default effort applies).",
    /*
    FNXC:SettingsSearch 2026-07-15-17:35:
    The copy says "thinking"/"reasoning effort" but never names a level, and the level names live in option labels, which the index does not read. Operators search the level they want to set.
    */
    keywords: ["high", "low", "medium", "xhigh", "extended thinking"],
  },
  {
    sectionId: "global-models",
    key: "openrouterModelSync",
    labelKey: "settings.globalModels.syncOpenRouterModelListAtStartup",
    labelFallback: " Sync OpenRouter model list at startup ",
    helpKey: "settings.globalModels.whenEnabledStartupFetchesTheLatestAvailableModels",
    helpFallback:
      " When enabled, startup fetches the latest available models from the OpenRouter API so model pickers always include the newest catalog. Default: enabled. ",
    keywords: ["refresh", "boot"],
  },
  {
    sectionId: "global-models",
    key: "openrouterAppAttribution.referer",
    labelKey: "settings.globalModels.openRouterHTTPReferer",
    labelFallback: "OpenRouter HTTP-Referer",
    helpKey: "settings.globalModels.leaveEmptyToOmitThisHeaderDefaultHttps",
    helpFallback:
      "Leave empty to omit this header. No default — unset (Fusion falls back to https://runfusion.ai when unset).",
    keywords: ["attribution", "app ranking"],
  },
  {
    sectionId: "global-models",
    key: "openrouterAppAttribution.title",
    labelKey: "settings.globalModels.openRouterXTitle",
    labelFallback: "OpenRouter X-Title",
    helpKey: "settings.globalModels.leaveEmptyToOmitThisHeaderDefaultFusion",
    helpFallback:
      "Leave empty to omit this header. No default — unset (Fusion falls back to the title \"Fusion\" when unset).",
    keywords: ["attribution", "app ranking"],
  },
  {
    sectionId: "global-models",
    key: "openrouterModelFilters.supported_parameters",
    labelKey: "settings.globalModels.openRouterSupportedParametersFilter",
    labelFallback: "OpenRouter supported_parameters filter",
    helpKey: "settings.globalModels.commaSeparatedValuesSentToOpenRouterModelSync",
    helpFallback: "Comma-separated values sent to OpenRouter model sync. No default — unset (unfiltered).",
    keywords: ["tools", "structured outputs", "catalog filter"],
  },
  {
    sectionId: "global-models",
    key: "openrouterModelFilters.output_modalities",
    labelKey: "settings.globalModels.openRouterOutputModalitiesFilter",
    labelFallback: "OpenRouter output_modalities filter",
    helpKey: "settings.globalModels.commaSeparatedValuesSentToOpenRouterModelSyncOutputModalities",
    helpFallback: "Comma-separated values sent to OpenRouter model sync. No default — unset (unfiltered).",
    keywords: ["text", "image", "catalog filter"],
  },
  {
    sectionId: "global-models",
    key: "openrouterProviderPreferences.order",
    labelKey: "settings.globalModels.openRouterRoutingOrder",
    labelFallback: "OpenRouter routing order",
    helpKey: "settings.globalModels.openRouterRoutingOrderHint",
    helpFallback: "No default — unset (OpenRouter's own default routing order applies).",
    keywords: ["provider preference", "priority"],
  },
  {
    sectionId: "global-models",
    key: "openrouterProviderPreferences.ignore",
    labelKey: "settings.globalModels.openRouterRoutingIgnore",
    labelFallback: "OpenRouter routing ignore",
    helpKey: "settings.globalModels.openRouterRoutingIgnoreHint",
    helpFallback: "No default — unset (no providers ignored).",
    keywords: ["exclude", "block", "deny provider"],
  },
  {
    sectionId: "global-models",
    key: "openrouterProviderPreferences.only",
    labelKey: "settings.globalModels.openRouterRoutingOnly",
    labelFallback: "OpenRouter routing only",
    helpKey: "settings.globalModels.openRouterRoutingOnlyHint",
    helpFallback: "No default — unset (no provider restriction).",
    keywords: ["allowlist", "restrict", "pin provider"],
  },
  {
    sectionId: "global-models",
    key: "openrouterProviderPreferences.allow_fallbacks",
    labelKey: "settings.globalModels.openRouterAllowFallbacks",
    labelFallback: "OpenRouter allow fallbacks",
    helpKey: "settings.globalModels.openRouterAllowFallbacksHint",
    helpFallback: "No default — unset (OpenRouter's own default fallback behavior applies).",
    keywords: ["backup provider", "failover"],
  },
  {
    sectionId: "global-models",
    key: "openrouterProviderPreferences.sort",
    labelKey: "settings.globalModels.openRouterRoutingSort",
    labelFallback: "OpenRouter routing sort",
    helpKey: "settings.globalModels.openRouterRoutingSortHint",
    helpFallback: "No default — unset (OpenRouter's own default sort applies).",
    keywords: ["price", "throughput", "latency", "cheapest", "fastest"],
  },
  {
    sectionId: "global-models",
    key: "openrouterProviderPreferences.require_parameters",
    labelKey: "settings.globalModels.requireParameters",
    labelFallback: " Require parameters ",
    helpKey: "settings.globalModels.requireParametersHint",
    helpFallback: "Default: disabled.",
    keywords: ["strict routing", "provider support"],
  },
];
