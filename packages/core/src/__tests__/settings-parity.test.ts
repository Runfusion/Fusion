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
    expect(isProjectSettingsKey("remoteAccess")).toBe(true);
    expect(isProjectSettingsKey("themeMode")).toBe(false);
    expect(isGlobalSettingsKey("remoteAccess")).toBe(false);
  });

  it("includes heartbeatMultiplier in project defaults", () => {
    expect(DEFAULT_PROJECT_SETTINGS.heartbeatMultiplier).toBe(1);
  });

  it("keeps remoteAccess scoped to project settings only", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];

    expect(projectKeys).toContain("remoteAccess");
    expect(globalKeys).not.toContain("remoteAccess");
    expect(DEFAULT_PROJECT_SETTINGS.remoteAccess).toBeDefined();
    expect((DEFAULT_GLOBAL_SETTINGS as Record<string, unknown>).remoteAccess).toBeUndefined();
  });

  it("No key appears in both GLOBAL_SETTINGS_KEYS and PROJECT_SETTINGS_KEYS", () => {
    const projectKeySet = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);
    const overlap = (GLOBAL_SETTINGS_KEYS as readonly string[]).filter((key) => projectKeySet.has(key));
    expect(overlap).toEqual([]);
  });
});

// ── Model Lane Key Parity Regression Tests (FN-1729) ────────────────────────

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
