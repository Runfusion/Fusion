import { describe, expect, it } from "vitest";
import { isResearchExperimentalEnabled, resolveResearchSettings } from "../research-settings.js";
import type { Settings } from "../types.js";

describe("isResearchExperimentalEnabled", () => {
  it("returns false when settings are missing", () => {
    expect(isResearchExperimentalEnabled(undefined)).toBe(false);
  });

  it("returns false when researchView is false", () => {
    expect(isResearchExperimentalEnabled({ experimentalFeatures: { researchView: false } as Record<string, boolean> } as Settings)).toBe(false);
  });

  it("returns true when researchView is true", () => {
    expect(isResearchExperimentalEnabled({ experimentalFeatures: { researchView: true } as Record<string, boolean> } as Settings)).toBe(true);
  });
});

describe("resolveResearchSettings", () => {
  it("resolves global-only defaults", () => {
    const resolved = resolveResearchSettings({
      researchGlobalDefaults: {
        searchProvider: "tavily",
        synthesisProvider: "anthropic",
        synthesisModelId: "claude-sonnet-4-5",
        enabledSources: {
          webSearch: true,
          pageFetch: true,
          github: false,
          localDocs: true,
          llmSynthesis: true,
        },
        maxSourcesPerRun: 12,
        defaultExportFormat: "json",
      },
      researchGlobalEnabled: true,
    });

    expect(resolved.searchProvider).toBe("tavily");
    expect(resolved.synthesisProvider).toBe("anthropic");
    expect(resolved.synthesisModelId).toBe("claude-sonnet-4-5");
    expect(resolved.enabled).toBe(true);
    expect(resolved.enabledSources.github).toBe(false);
    expect(resolved.limits.maxSourcesPerRun).toBe(12);
    expect(resolved.defaultExportFormat).toBe("json");
  });

  it("project values override global values", () => {
    const resolved = resolveResearchSettings({
      researchGlobalDefaults: { searchProvider: "brave", maxSourcesPerRun: 10 },
      researchSettings: {
        enabled: false,
        searchProvider: "tavily",
        limits: { maxSourcesPerRun: 3, maxConcurrentRuns: 1, maxDurationMs: 1000, requestTimeoutMs: 500 },
      },
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.searchProvider).toBe("tavily");
    expect(resolved.limits.maxSourcesPerRun).toBe(3);
    expect(resolved.limits.maxConcurrentRuns).toBe(1);
  });

  it("partial nested project overrides preserve remaining global defaults", () => {
    const resolved = resolveResearchSettings({
      researchGlobalDefaults: {
        enabledSources: {
          webSearch: true,
          pageFetch: true,
          github: true,
          localDocs: true,
          llmSynthesis: true,
        },
      },
      researchSettings: {
        enabledSources: { github: false },
      },
    });

    expect(resolved.enabledSources.github).toBe(false);
    expect(resolved.enabledSources.webSearch).toBe(true);
    expect(resolved.enabledSources.pageFetch).toBe(true);
  });

  it("clearing project override falls back to global/default", () => {
    const resolved = resolveResearchSettings({
      researchGlobalDefaults: {
        searchProvider: "brave",
      },
      researchSettings: {
        searchProvider: undefined,
      },
    });

    expect(resolved.searchProvider).toBe("brave");
  });

  it("forces web search on even when persisted settings disable it", () => {
    const resolved = resolveResearchSettings({
      researchGlobalDefaults: {
        enabledSources: {
          webSearch: false,
          pageFetch: true,
          github: false,
          localDocs: true,
          llmSynthesis: true,
        },
      },
      researchSettings: {
        enabledSources: {
          webSearch: false,
        },
      },
    });

    expect(resolved.enabledSources.webSearch).toBe(true);
  });

  it("supports null-as-delete semantics for researchSettings object", () => {
    const resolved = resolveResearchSettings({
      researchGlobalDefaults: {
        searchProvider: "tavily",
      },
      researchSettings: null as unknown as Settings["researchSettings"],
    });

    expect(resolved.searchProvider).toBe("tavily");
    expect(resolved.enabled).toBe(true);
  });

  it("falls back through legacy and hardcoded limit chains", () => {
    const fromLegacyProjectTimeout = resolveResearchSettings({
      researchDefaultTimeout: 111_000,
      researchGlobalFetchTimeoutMs: 8_000,
    });
    expect(fromLegacyProjectTimeout.limits.maxDurationMs).toBe(111_000);
    expect(fromLegacyProjectTimeout.limits.requestTimeoutMs).toBe(8_000);

    const fromLegacyGlobalTimeout = resolveResearchSettings({
      researchGlobalDefaultTimeout: 222_000,
      researchGlobalMaxConcurrentRuns: 9,
    });
    expect(fromLegacyGlobalTimeout.limits.maxDurationMs).toBe(222_000);
    expect(fromLegacyGlobalTimeout.limits.maxConcurrentRuns).toBe(9);

    const hardcodedFallback = resolveResearchSettings({});
    expect(hardcodedFallback.searchProvider).toBe("builtin");
    expect(hardcodedFallback.limits.maxDurationMs).toBe(300000);
    expect(hardcodedFallback.limits.requestTimeoutMs).toBe(30000);
    expect(hardcodedFallback.defaultExportFormat).toBe("markdown");
  });
});
