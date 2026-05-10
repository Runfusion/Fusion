import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalSettingsKey,
  isProjectSettingsKey,
} from "../types.js";

function assertExactKeyCoverage(scopeName: string, actual: readonly string[], expected: readonly string[]): void {
  const uniqueActual = [...new Set(actual)];
  const uniqueExpected = [...new Set(expected)];

  const missing = uniqueExpected.filter((key) => !uniqueActual.includes(key));
  const extra = uniqueActual.filter((key) => !uniqueExpected.includes(key));
  const duplicates = actual.filter((key, index) => actual.indexOf(key) !== index);

  if (missing.length > 0 || extra.length > 0 || duplicates.length > 0) {
    throw new Error(
      [
        `${scopeName} parity mismatch`,
        `Missing: ${missing.length ? missing.join(", ") : "(none)"}`,
        `Extra: ${extra.length ? extra.join(", ") : "(none)"}`,
        `Duplicates: ${duplicates.length ? [...new Set(duplicates)].join(", ") : "(none)"}`,
      ].join("\n"),
    );
  }
}

describe("settings key parity", () => {
  it("GLOBAL_SETTINGS_KEYS is derived from the global settings defaults", () => {
    assertExactKeyCoverage(
      "GLOBAL_SETTINGS_KEYS",
      GLOBAL_SETTINGS_KEYS as readonly string[],
      Object.keys(DEFAULT_GLOBAL_SETTINGS),
    );
  });

  it("PROJECT_SETTINGS_KEYS is derived from the project settings defaults", () => {
    assertExactKeyCoverage(
      "PROJECT_SETTINGS_KEYS",
      PROJECT_SETTINGS_KEYS as readonly string[],
      Object.keys(DEFAULT_PROJECT_SETTINGS),
    );
  });

  it("identifies settings scopes", () => {
    expect(isGlobalSettingsKey("themeMode")).toBe(true);
    expect(isGlobalSettingsKey("maxConcurrent")).toBe(false);
    expect(isProjectSettingsKey("maxConcurrent")).toBe(true);
    expect(isProjectSettingsKey("heartbeatMultiplier")).toBe(true);
    expect(isProjectSettingsKey("completionDocumentationMode")).toBe(true);
    expect(isProjectSettingsKey("remoteAccess")).toBe(false);
    expect(isProjectSettingsKey("researchSettings")).toBe(true);
    expect(isGlobalSettingsKey("researchGlobalDefaults")).toBe(true);
    expect(isProjectSettingsKey("themeMode")).toBe(false);
    expect(isGlobalSettingsKey("remoteAccess")).toBe(true);
    expect(isGlobalSettingsKey("persistAgentToolOutput")).toBe(true);
    expect(isProjectSettingsKey("persistAgentToolOutput")).toBe(false);
    expect(isGlobalSettingsKey("researchSettings")).toBe(false);
  });

  it("includes heartbeatMultiplier in project defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.heartbeatMultiplier).toBe(1);
  });

  it("defaults completionDocumentationMode to off", () => {
    expect(DEFAULT_PROJECT_SETTINGS.completionDocumentationMode).toBe("off");
  });

  it("keeps task stuck timeout active by default without coupling to workflow step timeout", () => {
    expect(DEFAULT_PROJECT_SETTINGS.taskStuckTimeoutMs).toBe(600_000);
    expect(DEFAULT_PROJECT_SETTINGS.workflowStepTimeoutMs).toBe(360_000);
  });

  it("keeps github tracking keys in expected scopes with documented defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.githubTrackingEnabledByDefault).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.githubTrackingDefaultRepo).toBeUndefined();
    expect(DEFAULT_PROJECT_SETTINGS.githubAuthMode).toBe("gh-cli");
    expect(DEFAULT_PROJECT_SETTINGS.githubAuthToken).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.githubTrackingDefaultRepo).toBeUndefined();

    expect(isProjectSettingsKey("githubTrackingEnabledByDefault")).toBe(true);
    expect(isGlobalSettingsKey("githubTrackingEnabledByDefault")).toBe(false);
    expect(isProjectSettingsKey("githubAuthMode")).toBe(true);
    expect(isGlobalSettingsKey("githubAuthMode")).toBe(false);
    expect(isProjectSettingsKey("githubAuthToken")).toBe(true);
    expect(isGlobalSettingsKey("githubAuthToken")).toBe(false);
    expect(isProjectSettingsKey("githubTrackingDefaultRepo")).toBe(true);
    expect(isGlobalSettingsKey("githubTrackingDefaultRepo")).toBe(true);
  });

  it("keeps remoteAccess scoped to global settings only", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];

    expect(projectKeys).not.toContain("remoteAccess");
    expect(globalKeys).toContain("remoteAccess");
    expect(DEFAULT_GLOBAL_SETTINGS.remoteAccess).toBeDefined();
    expect((DEFAULT_PROJECT_SETTINGS as Record<string, unknown>).remoteAccess).toBeUndefined();
  });

  it("keeps experimentalFeatures scoped to global settings only", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];

    expect(projectKeys).not.toContain("experimentalFeatures");
    expect(globalKeys).toContain("experimentalFeatures");
    expect(DEFAULT_GLOBAL_SETTINGS.experimentalFeatures).toBeDefined();
    expect((DEFAULT_PROJECT_SETTINGS as Record<string, unknown>).experimentalFeatures).toBeUndefined();
  });

  it("only intentional shared keys appear in both global and project scopes", () => {
    const projectKeySet = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);
    const overlap = (GLOBAL_SETTINGS_KEYS as readonly string[]).filter((key) => projectKeySet.has(key));
    expect(overlap).toEqual(["githubTrackingDefaultRepo"]);
  });
});

// ── Model Lane Key Parity Regression Tests (FN-1729) ────────────────────────

describe("research global key parity regression (FN-3313)", () => {
  const globalResearchFlatKeys = [
    "researchGlobalWebSearchProvider",
    "researchGlobalSearxngUrl",
    "researchGlobalBraveApiKey",
    "researchGlobalGoogleSearchApiKey",
    "researchGlobalGoogleSearchCx",
    "researchGlobalTavilyApiKey",
    "researchGlobalGitHubEnabled",
    "researchGlobalLocalDocsEnabled",
    "researchGlobalMaxSearchResults",
    "researchGlobalFetchTimeoutMs",
    "researchGlobalUserAgent",
  ] as const;

  it.each(globalResearchFlatKeys)("%s is global-scoped only", (key) => {
    expect(isGlobalSettingsKey(key)).toBe(true);
    expect(isProjectSettingsKey(key)).toBe(false);
  });
});

// ── Model Lane Key Parity Regression Tests (FN-1729) ────────────────────────

describe("eval settings parity regression (FN-3393)", () => {
  it("keeps evalSettings project-scoped with expected defaults", () => {
    expect(isProjectSettingsKey("evalSettings")).toBe(true);
    expect(isGlobalSettingsKey("evalSettings")).toBe(false);

    expect(DEFAULT_PROJECT_SETTINGS.evalSettings).toEqual({
      enabled: false,
      intervalMs: 86_400_000,
      evaluatorProvider: undefined,
      evaluatorModelId: undefined,
      followUpPolicy: "suggest-only",
      retentionDays: 30,
    });
  });
});

describe("model lane key parity regression (FN-1729)", () => {
  // All model lane provider/modelId pairs that should exist
  const allModelLanePairs = [
    // Default baseline (global only)
    { provider: "defaultProvider", modelId: "defaultModelId", expectedScope: "global" },
    // Fallback baseline (global only)
    { provider: "fallbackProvider", modelId: "fallbackModelId", expectedScope: "global" },
    // Execution lane
    { provider: "executionProvider", modelId: "executionModelId", expectedScope: "project" },
    { provider: "executionGlobalProvider", modelId: "executionGlobalModelId", expectedScope: "global" },
    // Planning lane
    { provider: "planningProvider", modelId: "planningModelId", expectedScope: "project" },
    { provider: "planningGlobalProvider", modelId: "planningGlobalModelId", expectedScope: "global" },
    { provider: "planningFallbackProvider", modelId: "planningFallbackModelId", expectedScope: "project" },
    // Validator lane
    { provider: "validatorProvider", modelId: "validatorModelId", expectedScope: "project" },
    { provider: "validatorGlobalProvider", modelId: "validatorGlobalModelId", expectedScope: "global" },
    { provider: "validatorFallbackProvider", modelId: "validatorFallbackModelId", expectedScope: "project" },
    // Summarizer lane
    { provider: "titleSummarizerProvider", modelId: "titleSummarizerModelId", expectedScope: "project" },
    { provider: "titleSummarizerGlobalProvider", modelId: "titleSummarizerGlobalModelId", expectedScope: "global" },
    { provider: "titleSummarizerFallbackProvider", modelId: "titleSummarizerFallbackModelId", expectedScope: "project" },
  ] as const;

  it.each(allModelLanePairs)(
    "$provider/$modelId is correctly classified as $expectedScope scope",
    ({ provider, modelId, expectedScope }) => {
      if (expectedScope === "global") {
        expect(isGlobalSettingsKey(provider)).toBe(true);
        expect(isGlobalSettingsKey(modelId)).toBe(true);
        expect(isProjectSettingsKey(provider)).toBe(false);
        expect(isProjectSettingsKey(modelId)).toBe(false);
      } else {
        expect(isProjectSettingsKey(provider)).toBe(true);
        expect(isProjectSettingsKey(modelId)).toBe(true);
        expect(isGlobalSettingsKey(provider)).toBe(false);
        expect(isGlobalSettingsKey(modelId)).toBe(false);
      }
    },
  );

  it("model lane keys appear in exactly one scope key list", () => {
    const globalKeys = new Set(GLOBAL_SETTINGS_KEYS as readonly string[]);
    const projectKeys = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);

    for (const { provider, modelId } of allModelLanePairs) {
      const inGlobal = globalKeys.has(provider) && globalKeys.has(modelId);
      const inProject = projectKeys.has(provider) && projectKeys.has(modelId);

      // Each pair must appear in exactly one scope
      expect(inGlobal || inProject).toBe(true);
      expect(inGlobal && inProject).toBe(false);
    }
  });

  it("all global model lane keys are in GLOBAL_SETTINGS_KEYS", () => {
    const globalKeys = new Set(GLOBAL_SETTINGS_KEYS as readonly string[]);

    const globalLanes = allModelLanePairs
      .filter((p) => p.expectedScope === "global")
      .flatMap((p) => [p.provider, p.modelId]);

    for (const key of globalLanes) {
      expect(globalKeys.has(key)).toBe(true);
    }
  });

  it("all project model lane keys are in PROJECT_SETTINGS_KEYS", () => {
    const projectKeys = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);

    const projectLanes = allModelLanePairs
      .filter((p) => p.expectedScope === "project")
      .flatMap((p) => [p.provider, p.modelId]);

    for (const key of projectLanes) {
      expect(projectKeys.has(key)).toBe(true);
    }
  });

  it("default override keys are in project scope", () => {
    expect(isProjectSettingsKey("defaultProviderOverride")).toBe(true);
    expect(isProjectSettingsKey("defaultModelIdOverride")).toBe(true);
    expect(isGlobalSettingsKey("defaultProviderOverride")).toBe(false);
    expect(isGlobalSettingsKey("defaultModelIdOverride")).toBe(false);
  });

  it("no model lane provider exists without its corresponding modelId key", () => {
    const allKeys = new Set([...GLOBAL_SETTINGS_KEYS, ...PROJECT_SETTINGS_KEYS]);

    for (const { provider, modelId } of allModelLanePairs) {
      // Both must exist or neither should exist
      const hasProvider = allKeys.has(provider);
      const hasModelId = allKeys.has(modelId);
      expect(hasProvider).toBe(hasModelId);
    }
  });
});
