import { describe, expect, it } from "vitest";

import type { Settings } from "../types.js";
import { applyWorkflowSettingsOverlay } from "../config/effective-settings-overlay.js";

describe("applyWorkflowSettingsOverlay", () => {
  it("applies the two-tier workflow settings overlay without mutating base settings", () => {
    const base = {
      executionProvider: "base-executor",
      executionModelId: "base-executor-model",
      validatorProvider: "base-validator",
      planningProvider: "base-planning",
      workflowStepTimeoutMs: 10_000,
    } as Partial<Settings>;

    const merged = applyWorkflowSettingsOverlay(base, {
      effective: {
        executionProvider: "workflow-executor",
        executionModelId: "workflow-executor-model",
        validatorProvider: "workflow-validator",
        validatorModelId: "workflow-validator-model",
        planningProvider: "workflow-planner",
        planningModelId: "workflow-planner-model",
        planningFallbackProvider: "workflow-planner-fallback",
        planningFallbackModelId: "workflow-planner-fallback-model",
        planningFallbackThinkingLevel: "high",
        validatorFallbackProvider: "workflow-validator-fallback",
        validatorFallbackModelId: "workflow-validator-fallback-model",
        validatorFallbackThinkingLevel: "high",
        workflowStepTimeoutMs: 900_000,
        runStepsInNewSessions: false,
        maxParallelSteps: undefined,
      },
      storedKeys: new Set([
        "executionProvider",
        "executionModelId",
        "validatorProvider",
        "validatorModelId",
        "planningProvider",
        "planningModelId",
        "planningFallbackProvider",
        "planningFallbackModelId",
        "planningFallbackThinkingLevel",
        "validatorFallbackProvider",
        "validatorFallbackModelId",
        "validatorFallbackThinkingLevel",
      ]),
    });

    expect(merged).not.toBe(base);
    expect(base).toEqual({
      executionProvider: "base-executor",
      executionModelId: "base-executor-model",
      validatorProvider: "base-validator",
      planningProvider: "base-planning",
      workflowStepTimeoutMs: 10_000,
    });
    expect(merged).toMatchObject({
      executionProvider: "workflow-executor",
      executionModelId: "workflow-executor-model",
      validatorProvider: "workflow-validator",
      validatorModelId: "workflow-validator-model",
      planningProvider: "workflow-planner",
      planningModelId: "workflow-planner-model",
      planningFallbackProvider: "workflow-planner-fallback",
      planningFallbackModelId: "workflow-planner-fallback-model",
      planningFallbackThinkingLevel: "high",
      validatorFallbackProvider: "workflow-validator-fallback",
      validatorFallbackModelId: "workflow-validator-fallback-model",
      validatorFallbackThinkingLevel: "high",
      workflowStepTimeoutMs: 10_000,
      runStepsInNewSessions: false,
    });
    expect("maxParallelSteps" in merged).toBe(false);
  });
});
