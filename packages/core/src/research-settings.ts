import type { ResearchEnabledSources, Settings } from "./types.js";
import { isExperimentalFeatureEnabled } from "./experimental-features.js";

export function isResearchExperimentalEnabled(settings: Partial<Settings> | undefined): boolean {
  return isExperimentalFeatureEnabled(settings, "researchView");
}

export interface ResolvedResearchSettings {
  enabled: boolean;
  searchProvider?: string;
  synthesisProvider?: string;
  synthesisModelId?: string;
  enabledSources: ResearchEnabledSources;
  limits: {
    maxConcurrentRuns: number;
    maxSourcesPerRun: number;
    maxDurationMs: number;
    requestTimeoutMs: number;
  };
  defaultExportFormat: "markdown" | "json";
}

const DEFAULT_SEARCH_PROVIDER = "builtin";

const FALLBACK_SOURCES: Omit<ResearchEnabledSources, "webSearch"> = {
  pageFetch: true,
  github: false,
  localDocs: true,
  llmSynthesis: true,
};

export function resolveResearchSettings(settings: Partial<Settings> | undefined): ResolvedResearchSettings {
  const globalDefaults = settings?.researchGlobalDefaults;
  const projectSettings = settings?.researchSettings;

  return {
    enabled: projectSettings?.enabled ?? settings?.researchEnabled ?? settings?.researchGlobalEnabled ?? true,
    searchProvider:
      projectSettings?.searchProvider ??
      globalDefaults?.searchProvider ??
      settings?.researchGlobalWebSearchProvider ??
      DEFAULT_SEARCH_PROVIDER,
    synthesisProvider: projectSettings?.synthesisProvider ?? globalDefaults?.synthesisProvider,
    synthesisModelId: projectSettings?.synthesisModelId ?? globalDefaults?.synthesisModelId,
    enabledSources: {
      webSearch: true,
      pageFetch:
        projectSettings?.enabledSources?.pageFetch ??
        globalDefaults?.enabledSources?.pageFetch ??
        FALLBACK_SOURCES.pageFetch,
      github:
        projectSettings?.enabledSources?.github ??
        globalDefaults?.enabledSources?.github ??
        FALLBACK_SOURCES.github,
      localDocs:
        projectSettings?.enabledSources?.localDocs ??
        globalDefaults?.enabledSources?.localDocs ??
        FALLBACK_SOURCES.localDocs,
      llmSynthesis:
        projectSettings?.enabledSources?.llmSynthesis ??
        globalDefaults?.enabledSources?.llmSynthesis ??
        FALLBACK_SOURCES.llmSynthesis,
    },
    limits: {
      maxConcurrentRuns: projectSettings?.limits?.maxConcurrentRuns ?? settings?.researchMaxConcurrentRuns ?? settings?.researchGlobalMaxConcurrentRuns ?? 3,
      maxSourcesPerRun: projectSettings?.limits?.maxSourcesPerRun ?? globalDefaults?.maxSourcesPerRun ?? settings?.researchMaxSourcesPerRun ?? settings?.researchGlobalMaxSourcesPerRun ?? 20,
      maxDurationMs: projectSettings?.limits?.maxDurationMs ?? settings?.researchDefaultTimeout ?? settings?.researchGlobalDefaultTimeout ?? 300000,
      requestTimeoutMs: projectSettings?.limits?.requestTimeoutMs ?? settings?.researchGlobalFetchTimeoutMs ?? 30000,
    },
    defaultExportFormat: globalDefaults?.defaultExportFormat ?? "markdown",
  };
}
