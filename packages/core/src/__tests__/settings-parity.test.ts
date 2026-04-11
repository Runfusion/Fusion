import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
} from "../types.js";
import type { GlobalSettings, ProjectSettings } from "../types.js";

const GLOBAL_KEYS: (keyof GlobalSettings)[] = [
  "themeMode",
  "colorTheme",
  "defaultProvider",
  "defaultModelId",
  "fallbackProvider",
  "fallbackModelId",
  "defaultThinkingLevel",
  "ntfyEnabled",
  "ntfyTopic",
  "ntfyEvents",
  "ntfyDashboardHost",
  "defaultProjectId",
  "setupComplete",
  "favoriteProviders",
  "favoriteModels",
  "openrouterModelSync",
  "modelOnboardingComplete",
];

const PROJECT_KEYS: (keyof ProjectSettings)[] = [
  "globalPause",
  "enginePaused",
  "maxConcurrent",
  "maxWorktrees",
  "pollIntervalMs",
  "groupOverlappingFiles",
  "autoMerge",
  "mergeStrategy",
  "worktreeInitCommand",
  "testCommand",
  "buildCommand",
  "recycleWorktrees",
  "worktreeNaming",
  "taskPrefix",
  "includeTaskIdInCommit",
  "planningProvider",
  "planningModelId",
  "planningFallbackProvider",
  "planningFallbackModelId",
  "validatorProvider",
  "validatorModelId",
  "validatorFallbackProvider",
  "validatorFallbackModelId",
  "modelPresets",
  "autoSelectModelPreset",
  "defaultPresetBySize",
  "autoResolveConflicts",
  "smartConflictResolution",
  "strictScopeEnforcement",
  "buildRetryCount",
  "buildTimeoutMs",
  "requirePlanApproval",
  "taskStuckTimeoutMs",
  "aiSessionTtlMs",
  "aiSessionCleanupIntervalMs",
  "autoUnpauseEnabled",
  "autoUnpauseBaseDelayMs",
  "autoUnpauseMaxDelayMs",
  "maxStuckKills",
  "maxSpawnedAgentsPerParent",
  "maxSpawnedAgentsGlobal",
  "maintenanceIntervalMs",
  "autoUpdatePrStatus",
  "autoCreatePr",
  "autoBackupEnabled",
  "autoBackupSchedule",
  "autoBackupRetention",
  "autoBackupDir",
  "autoSummarizeTitles",
  "titleSummarizerProvider",
  "titleSummarizerModelId",
  "titleSummarizerFallbackProvider",
  "titleSummarizerFallbackModelId",
  "scripts",
  "setupScript",
  "insightExtractionEnabled",
  "insightExtractionSchedule",
  "insightExtractionMinIntervalMs",
  "memoryEnabled",
  "tokenCap",
  "runStepsInNewSessions",
  "maxParallelSteps",
  "missionStaleThresholdMs",
  "missionMaxTaskRetries",
  "missionHealthCheckIntervalMs",
  "agentPrompts",
  "promptOverrides",
  "reflectionEnabled",
  "reflectionIntervalMs",
  "reflectionAfterTask",
  "reviewHandoffPolicy",
  "showQuickChatFAB",
];

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
  it("GLOBAL_SETTINGS_KEYS covers all GlobalSettings keys", () => {
    assertExactKeyCoverage("GLOBAL_SETTINGS_KEYS", GLOBAL_SETTINGS_KEYS as readonly string[], GLOBAL_KEYS as string[]);
  });

  it("PROJECT_SETTINGS_KEYS covers all ProjectSettings keys", () => {
    assertExactKeyCoverage("PROJECT_SETTINGS_KEYS", PROJECT_SETTINGS_KEYS as readonly string[], PROJECT_KEYS as string[]);
  });

  it("DEFAULT_GLOBAL_SETTINGS covers all GlobalSettings keys", () => {
    assertExactKeyCoverage(
      "DEFAULT_GLOBAL_SETTINGS",
      Object.keys(DEFAULT_GLOBAL_SETTINGS),
      GLOBAL_KEYS as string[],
    );
  });

  it("DEFAULT_PROJECT_SETTINGS covers all ProjectSettings keys", () => {
    assertExactKeyCoverage(
      "DEFAULT_PROJECT_SETTINGS",
      Object.keys(DEFAULT_PROJECT_SETTINGS),
      PROJECT_KEYS as string[],
    );
  });

  it("No key appears in both GLOBAL_SETTINGS_KEYS and PROJECT_SETTINGS_KEYS", () => {
    const projectKeySet = new Set(PROJECT_SETTINGS_KEYS as readonly string[]);
    const overlap = (GLOBAL_SETTINGS_KEYS as readonly string[]).filter((key) => projectKeySet.has(key));
    expect(overlap).toEqual([]);
  });
});
