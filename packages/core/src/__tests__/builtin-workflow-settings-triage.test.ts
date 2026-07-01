import { describe, expect, it } from "vitest";
import {
  BUILTIN_MOVED_WORKFLOW_SETTINGS,
  BUILTIN_REVIEW_REVISION_SETTINGS,
  BUILTIN_TRIAGE_POLICY_SETTINGS,
  BUILTIN_WORKFLOW_SETTINGS,
  renderTriagePolicyPlaceholders,
} from "../builtin-workflow-settings.js";
import { MOVED_SETTINGS_KEYS } from "../moved-settings.js";

const expectedDefaults: Record<string, { type: string; default: unknown }> = {
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
});
