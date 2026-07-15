import { describe, expect, it } from "vitest";
import {
  BUILTIN_MOVED_WORKFLOW_SETTINGS,
  BUILTIN_OVERSIGHT_SETTINGS,
  BUILTIN_REVIEW_REVISION_SETTINGS,
  BUILTIN_TRIAGE_POLICY_SETTINGS,
  BUILTIN_WORKFLOW_SETTINGS,
  renderTriagePolicyPlaceholders,
} from "../builtin-workflow-settings.js";
import { MOVED_SETTINGS_KEYS } from "../moved-settings.js";

const expectedDefaults: Record<string, { type: string; default: unknown }> = {
  triageProactiveSubtaskSplittingEnabled: { type: "boolean", default: true },
  triageSizeSmallMaxHours: { type: "number", default: 2 },
  triageSizeMediumMaxHours: { type: "number", default: 4 },
  triageSizeLargeMaxHours: { type: "number", default: 8 },
  triageSubtaskStepThreshold: { type: "number", default: 7 },
  triageSubtaskLargeStepSignal: { type: "number", default: 9 },
  triageSubtaskAdditiveStepSignal: { type: "number", default: 12 },
  triageSubtaskPackageThreshold: { type: "number", default: 3 },
  triageSubtaskFileScopeThreshold: { type: "number", default: 20 },
  triageSubtaskRemediationBatchThreshold: { type: "number", default: 30 },
  triageNoCommitsDecisionVerbs: {
    type: "multi-enum",
    default: ["Decide", "Evaluate", "Verify", "Confirm", "Audit", "Review whether", "Investigate and report"],
  },
  triageDecisionOnlyWorkflowId: { type: "enum", default: "builtin:quick-fix" },
  triageDefaultWorkflowId: { type: "enum", default: "builtin:coding" },
  leanPlanning: { type: "boolean", default: false },
  autoApproveSpec: { type: "boolean", default: false },
};

describe("workflow-native built-in workflow settings", () => {
  it("declares behavior-equivalent triage defaults outside the moved-key catalog", () => {
    const triageById = new Map(BUILTIN_TRIAGE_POLICY_SETTINGS.map((setting) => [setting.id, setting]));
    const fullIds = new Set(BUILTIN_WORKFLOW_SETTINGS.map((setting) => setting.id));
    const movedIds = new Set(BUILTIN_MOVED_WORKFLOW_SETTINGS.map((setting) => setting.id));
    const movedKeyIds = new Set(MOVED_SETTINGS_KEYS);

    expect(BUILTIN_TRIAGE_POLICY_SETTINGS).toHaveLength(Object.keys(expectedDefaults).length);
    for (const [id, expected] of Object.entries(expectedDefaults)) {
      const setting = triageById.get(id);
      expect(setting, `${id} should be declared`).toBeDefined();
      expect(setting?.type).toBe(expected.type);
      expect(setting?.default).toStrictEqual(expected.default);
      expect(fullIds.has(id), `${id} should be in the full built-in catalog`).toBe(true);
      expect(movedIds.has(id), `${id} should not be in the moved-key catalog`).toBe(false);
      expect(movedKeyIds.has(id), `${id} should not be in MOVED_SETTINGS_KEYS`).toBe(false);
    }
  });

  it("declares review revision caps as unset workflow values outside moved/project settings", () => {
    const revisionById = new Map(BUILTIN_REVIEW_REVISION_SETTINGS.map((setting) => [setting.id, setting]));
    const fullIds = new Set(BUILTIN_WORKFLOW_SETTINGS.map((setting) => setting.id));
    const movedIds = new Set(BUILTIN_MOVED_WORKFLOW_SETTINGS.map((setting) => setting.id));
    const movedKeyIds = new Set(MOVED_SETTINGS_KEYS);

    expect(BUILTIN_REVIEW_REVISION_SETTINGS.map((setting) => setting.id)).toEqual([
      "reviewerInlineFixes",
      "planReviewMaxRevisions",
      "codeReviewMaxRevisions",
    ]);
    const inlineFixes = revisionById.get("reviewerInlineFixes");
    expect(inlineFixes).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(fullIds.has("reviewerInlineFixes")).toBe(true);
    expect(movedIds.has("reviewerInlineFixes")).toBe(false);
    expect(movedKeyIds.has("reviewerInlineFixes")).toBe(false);
    for (const id of ["planReviewMaxRevisions", "codeReviewMaxRevisions"]) {
      const setting = revisionById.get(id);
      expect(setting, `${id} should be declared`).toBeDefined();
      expect(setting?.type).toBe("number");
      expect(setting).not.toHaveProperty("default");
      expect(setting?.description).toMatch(/Leave unset for unbounded|Leave unset|unbounded/i);
      expect(setting?.description).toContain("0");
      expect(fullIds.has(id), `${id} should be in the full built-in catalog`).toBe(true);
      expect(movedIds.has(id), `${id} should not be in the moved-key catalog`).toBe(false);
      expect(movedKeyIds.has(id), `${id} should not be in MOVED_SETTINGS_KEYS`).toBe(false);
    }
  });

  it("declares planner oversight level as a workflow-native enum outside moved/project settings", () => {
    const fullIds = new Set(BUILTIN_WORKFLOW_SETTINGS.map((setting) => setting.id));
    const movedIds = new Set(BUILTIN_MOVED_WORKFLOW_SETTINGS.map((setting) => setting.id));
    const movedKeyIds = new Set(MOVED_SETTINGS_KEYS);

    expect(BUILTIN_OVERSIGHT_SETTINGS.map((setting) => setting.id)).toEqual([
      "plannerOversightLevel",
      "plannerOversightNotificationLevel",
      "plannerOverseerExecutorStuckAfterMs",
      "plannerOverseerAdvisorEnabled",
      "plannerOverseerAdvisorProvider",
      "plannerOverseerAdvisorModelId",
    ]);
    // FNXC:PlannerOversight 2026-07-14-12:00: LLM session advisor must default OFF.
    expect(BUILTIN_OVERSIGHT_SETTINGS.find((s) => s.id === "plannerOverseerAdvisorEnabled")).toMatchObject({
      type: "boolean",
      default: false,
    });
    const oversight = BUILTIN_OVERSIGHT_SETTINGS[0];
    expect(oversight).toMatchObject({
      type: "enum",
      default: "autonomous",
    });
    expect(oversight.options?.map((option) => option.value)).toEqual(["off", "observe", "steer", "autonomous"]);
    expect(oversight.options?.map((option) => option.label)).toEqual([
      "Off",
      "Observe",
      "Steer",
      "Autonomous recovery",
    ]);
    expect(fullIds.has("plannerOversightLevel"), "plannerOversightLevel should be in the full built-in catalog").toBe(
      true,
    );
    expect(
      movedIds.has("plannerOversightLevel"),
      "plannerOversightLevel should not be in the moved-key catalog",
    ).toBe(false);
    expect(
      movedKeyIds.has("plannerOversightLevel"),
      "plannerOversightLevel should not be in MOVED_SETTINGS_KEYS",
    ).toBe(false);

    const notificationLevel = BUILTIN_OVERSIGHT_SETTINGS[1];
    expect(notificationLevel).toMatchObject({
      id: "plannerOversightNotificationLevel",
      type: "enum",
      default: "important",
    });
    expect(notificationLevel.options?.map((option) => option.value)).toEqual([
      "silent",
      "errors",
      "important",
      "all",
    ]);
    expect(notificationLevel.options?.map((option) => option.label)).toEqual([
      "Silent",
      "Errors only",
      "Important",
      "All",
    ]);
    expect(
      fullIds.has("plannerOversightNotificationLevel"),
      "plannerOversightNotificationLevel should be in the full built-in catalog",
    ).toBe(true);
    expect(
      movedIds.has("plannerOversightNotificationLevel"),
      "plannerOversightNotificationLevel should not be in the moved-key catalog",
    ).toBe(false);
    expect(
      movedKeyIds.has("plannerOversightNotificationLevel"),
      "plannerOversightNotificationLevel should not be in MOVED_SETTINGS_KEYS",
    ).toBe(false);

    // FN-7743: executor-stall recovery threshold, declared alongside the other
    // workflow-native oversight settings.
    const executorStuckAfterMs = BUILTIN_OVERSIGHT_SETTINGS[2];
    expect(executorStuckAfterMs).toMatchObject({
      id: "plannerOverseerExecutorStuckAfterMs",
      type: "number",
      default: 2 * 60 * 60 * 1000,
    });
    expect(
      fullIds.has("plannerOverseerExecutorStuckAfterMs"),
      "plannerOverseerExecutorStuckAfterMs should be in the full built-in catalog",
    ).toBe(true);
    expect(
      movedIds.has("plannerOverseerExecutorStuckAfterMs"),
      "plannerOverseerExecutorStuckAfterMs should not be in the moved-key catalog",
    ).toBe(false);
    expect(
      movedKeyIds.has("plannerOverseerExecutorStuckAfterMs"),
      "plannerOverseerExecutorStuckAfterMs should not be in MOVED_SETTINGS_KEYS",
    ).toBe(false);
  });

  it("renders placeholders from resolved settings and rejects dangling tokens", () => {
    const prompt = [
      "Size S (<{{triageSizeSmallMaxHours}}h)",
      "MORE THAN {{triageSubtaskStepThreshold}} implementation steps",
      "verbs: {{triageNoCommitsDecisionVerbs}}",
    ].join("\n");

    const rendered = renderTriagePolicyPlaceholders(prompt, {
      triageSizeSmallMaxHours: 1,
      triageSubtaskStepThreshold: 5,
      triageNoCommitsDecisionVerbs: ["Audit", "Confirm"],
    } as never);

    expect(rendered).toContain("Size S (<1h)");
    expect(rendered).toContain("MORE THAN 5 implementation steps");
    expect(rendered).toContain("verbs: Audit, Confirm");
    expect(rendered).not.toContain("{{");
    expect(() => renderTriagePolicyPlaceholders("{{unknownTriageToken}}", {})).toThrow(/Unresolved triage policy placeholder/);
  });

  it("renders proactive splitting policy as enabled by default", () => {
    const rendered = renderTriagePolicyPlaceholders("{{triageProactiveSubtaskSplittingEnabled}}", {});

    expect(rendered).toContain("For tasks you assess as Size M or L, consider whether splitting");
    expect(rendered).toContain("Even when `breakIntoSubtasks` is not set to `true`, apply these thresholds proactively");
    expect(rendered).toContain("MORE THAN 7 implementation steps");
    expect(rendered).not.toContain("Proactive oversized-task splitting is DISABLED");
    expect(rendered).not.toContain("{{");
  });

  it("renders disabled proactive policy without weakening explicit subtask requests", () => {
    const rendered = renderTriagePolicyPlaceholders("{{triageProactiveSubtaskSplittingEnabled}}", {
      triageProactiveSubtaskSplittingEnabled: false,
    } as never);

    expect(rendered).toContain("Proactive oversized-task splitting is DISABLED");
    expect(rendered).toContain("Do NOT split solely because the task is Size M/L");
    expect(rendered).toContain("Only create child tasks when `breakIntoSubtasks: true` is explicitly present");
    expect(rendered).not.toContain("Even when `breakIntoSubtasks` is not set to `true`, apply these thresholds proactively");
    expect(rendered).not.toContain("{{");
  });
});
