import { describe, it, expect, vi } from "vitest";

import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import {
  resolveEffectiveSettings,
  resolveEffectiveSettingsById,
  resolveOptionalReviewRevisionBudget,
  resolveEffectivePlannerOversightLevel,
  type WorkflowSettingsResolverStore,
} from "../workflow-settings-resolver.js";

const PROJECT = "proj-1";

/** A custom workflow IR with NO settings declarations (declaration-absent path). */
const CUSTOM_NO_SETTINGS: WorkflowIr = {
  version: "v2",
  name: "custom-no-settings",
  columns: [{ id: "todo", name: "Todo", traits: [] }],
  nodes: [
    { id: "start", kind: "start" },
    { id: "end", kind: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};

/** A custom workflow IR declaring a single setting (workflowStepTimeoutMs). */
const CUSTOM_WITH_SETTING: WorkflowIr = {
  ...CUSTOM_NO_SETTINGS,
  name: "custom-with-setting",
  settings: [
    { id: "workflowStepTimeoutMs", name: "Step timeout", type: "number", default: 99_000 },
  ],
};

function makeStore(opts: {
  selection?: Record<string, { workflowId: string; stepIds: string[] }>;
  selectionThrows?: boolean;
  defs?: Record<string, { ir: string | WorkflowIr } | undefined>;
  values?: Record<string, Record<string, unknown>>; // key: `${workflowId}::${projectId}`
  valuesThrows?: boolean;
  projectId?: string;
  projectIdThrows?: boolean;
}): WorkflowSettingsResolverStore {
  return {
    getTaskWorkflowSelection: vi.fn((taskId: string) => {
      if (opts.selectionThrows) throw new Error("boom");
      return opts.selection?.[taskId];
    }),
    getWorkflowDefinition: vi.fn(async (id: string) => opts.defs?.[id]),
    getWorkflowSettingValues: vi.fn((workflowId: string, projectId: string) => {
      if (opts.valuesThrows) throw new Error("values boom");
      return opts.values?.[`${workflowId}::${projectId}`] ?? {};
    }),
    getWorkflowSettingsProjectId: vi.fn(() => {
      if (opts.projectIdThrows) throw new Error("identity boom");
      return opts.projectId ?? PROJECT;
    }),
  };
}

describe("resolveOptionalReviewRevisionBudget", () => {
  it("treats unset built-in Plan Review and Code Review settings as unbounded", () => {
    expect(resolveOptionalReviewRevisionBudget({ optionalGroupId: "plan-review", workflowSettings: {} })).toBe("unbounded");
    expect(resolveOptionalReviewRevisionBudget({ optionalGroupId: "code-review", workflowSettings: {} })).toBe("unbounded");
  });

  it("uses explicit workflow values before node config, including zero", () => {
    expect(
      resolveOptionalReviewRevisionBudget({
        optionalGroupId: "plan-review",
        workflowSettings: { planReviewMaxRevisions: 2 },
        nodeMaxRevisions: "unbounded",
      }),
    ).toBe(2);
    expect(
      resolveOptionalReviewRevisionBudget({
        optionalGroupId: "code-review",
        workflowSettings: { codeReviewMaxRevisions: 0 },
        nodeMaxRevisions: "unbounded",
      }),
    ).toBe(0);
  });

  it("preserves authored node maxRevisions for custom or duplicated workflows", () => {
    expect(
      resolveOptionalReviewRevisionBudget({
        optionalGroupId: "plan-review",
        workflowSettings: {},
        nodeMaxRevisions: 4,
      }),
    ).toBe(4);
    expect(
      resolveOptionalReviewRevisionBudget({
        optionalGroupId: "custom-review",
        workflowSettings: { planReviewMaxRevisions: 1 },
        nodeMaxRevisions: "unbounded",
        fallbackMaxRevisions: 3,
      }),
    ).toBe("unbounded");
  });

  it("ignores invalid workflow and node budgets safely", () => {
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, "3"]) {
      expect(
        resolveOptionalReviewRevisionBudget({
          optionalGroupId: "plan-review",
          workflowSettings: { planReviewMaxRevisions: invalid },
          nodeMaxRevisions: 5,
        }),
      ).toBe(5);
    }
    expect(
      resolveOptionalReviewRevisionBudget({
        optionalGroupId: "custom-review",
        nodeMaxRevisions: -1 as never,
        fallbackMaxRevisions: 3,
      }),
    ).toBe(3);
  });

  it("leaves Browser Verification and other optional gates on the existing fallback unless configured", () => {
    expect(
      resolveOptionalReviewRevisionBudget({
        optionalGroupId: "browser-verification",
        workflowSettings: {},
        fallbackMaxRevisions: 3,
      }),
    ).toBe(3);
    expect(resolveOptionalReviewRevisionBudget({ optionalGroupId: "browser-verification", workflowSettings: {} })).toBeUndefined();
  });
});

describe("resolveEffectiveSettings (per-task)", () => {
  it("parity anchor: builtin:coding with no stored values → effective equals declaration defaults", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "builtin:coding", stepIds: [] } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    // Every catalog key with a default contributes its declaration default to the
    // effective map. (Post-U4 hard-move the legacy DEFAULT_PROJECT_SETTINGS literals
    // for these keys are GONE — the declaration default is now the single source of
    // truth, byte-equal to what the legacy literal used to be.)
    for (const s of BUILTIN_WORKFLOW_SETTINGS) {
      if (s.default === undefined) {
        // Absent-default lanes contribute nothing to the effective map.
        expect(Object.prototype.hasOwnProperty.call(eff, s.id)).toBe(false);
      } else {
        expect(eff[s.id]).toStrictEqual(s.default);
      }
    }
    expect(eff.plannerOversightLevel).toBe("autonomous");
    expect(eff.plannerOversightNotificationLevel).toBe("important");
  });

  it("a stored value for (workflow, project) is returned over the default", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "builtin:coding", stepIds: [] } },
      values: { "builtin:coding::proj-1": { workflowStepTimeoutMs: 5_000, requirePrApproval: true } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    expect(eff.workflowStepTimeoutMs).toBe(5_000);
    expect(eff.requirePrApproval).toBe(true);
    // Untouched key falls to the declaration default.
    expect(eff.runStepsInNewSessions).toBe(false);
  });

  it("two tasks resolving different workflows each get their own effective values", async () => {
    const store = makeStore({
      selection: {
        t1: { workflowId: "builtin:coding", stepIds: [] },
        t2: { workflowId: "wf-custom", stepIds: [] },
      },
      defs: { "wf-custom": { ir: CUSTOM_WITH_SETTING } },
      values: {
        "builtin:coding::proj-1": { workflowStepTimeoutMs: 5_000 },
        "wf-custom::proj-1": { workflowStepTimeoutMs: 12_000 },
      },
    });
    const a = await resolveEffectiveSettings(store, { id: "t1" });
    const b = await resolveEffectiveSettings(store, { id: "t2" });
    expect(a.workflowStepTimeoutMs).toBe(5_000);
    expect(b.workflowStepTimeoutMs).toBe(12_000);
    // The custom workflow declares ONLY workflowStepTimeoutMs, so nothing else is in its map.
    expect(Object.prototype.hasOwnProperty.call(b, "requirePrApproval")).toBe(false);
  });

  it("custom workflow with empty settings → declaration-absent map (read-site fallback applies)", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "wf-empty", stepIds: [] } },
      defs: { "wf-empty": { ir: CUSTOM_NO_SETTINGS } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    // No declarations → no moved key in the effective map → engine read site keeps
    // its `?? <literal>` fallback (= the legacy default; asserted by the alignment test).
    expect(Object.keys(eff)).toHaveLength(0);
  });

  it("new custom workflow with empty settings does NOT inherit another workflow's values", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "wf-new", stepIds: [] } },
      defs: { "wf-new": { ir: CUSTOM_NO_SETTINGS } },
      // A different workflow has a customized value; the new one must not see it.
      values: { "builtin:coding::proj-1": { workflowStepTimeoutMs: 5_000 } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    expect(Object.prototype.hasOwnProperty.call(eff, "workflowStepTimeoutMs")).toBe(false);
  });

  it("absent-default model lanes are omitted (never undefined) so the merge can't clobber", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "builtin:coding", stepIds: [] } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    for (const lane of ["executionProvider", "executionModelId", "planningProvider", "validatorProvider"]) {
      expect(Object.prototype.hasOwnProperty.call(eff, lane)).toBe(false);
    }
  });

  it("a set model lane wins; unset lanes stay absent", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "builtin:coding", stepIds: [] } },
      values: { "builtin:coding::proj-1": { executionProvider: "anthropic" } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    expect(eff.executionProvider).toBe("anthropic");
    expect(Object.prototype.hasOwnProperty.call(eff, "executionModelId")).toBe(false);
  });

  it("no selection → builtin:coding declaration defaults (never throws)", async () => {
    const store = makeStore({ selection: {} });
    const eff = await resolveEffectiveSettings(store, { id: "t-none" });
    expect(eff.workflowStepTimeoutMs).toBe(900_000);
  });

  it("missing custom definition degrades to builtin declarations (never throws)", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "wf-gone", stepIds: [] } },
      defs: { "wf-gone": undefined },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    // Degrades to BUILTIN_CODING_WORKFLOW_IR declarations.
    expect(eff.workflowStepTimeoutMs).toBe(900_000);
  });

  it("selection lookup throwing degrades to builtin declarations", async () => {
    const store = makeStore({ selectionThrows: true });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    expect(eff.workflowStepTimeoutMs).toBe(900_000);
  });

  it("store value read throwing degrades to declaration defaults", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "builtin:coding", stepIds: [] } },
      valuesThrows: true,
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    expect(eff.workflowStepTimeoutMs).toBe(900_000);
  });

  it("project-id lookup throwing degrades to declaration defaults (empty stored map)", async () => {
    const store = makeStore({
      selection: { t1: { workflowId: "builtin:coding", stepIds: [] } },
      projectIdThrows: true,
      values: { "builtin:coding::proj-1": { workflowStepTimeoutMs: 5_000 } },
    });
    const eff = await resolveEffectiveSettings(store, { id: "t1" });
    // The stored 5_000 is unreachable because the project key couldn't be resolved.
    expect(eff.workflowStepTimeoutMs).toBe(900_000);
  });
});

describe("resolveEffectiveSettingsById", () => {
  it("resolves declarations + stored values for an explicit (workflowId, projectId)", async () => {
    const store = makeStore({
      defs: { "wf-custom": { ir: CUSTOM_WITH_SETTING } },
      values: { "wf-custom::proj-9": { workflowStepTimeoutMs: 7_000 } },
    });
    const eff = await resolveEffectiveSettingsById(store, "wf-custom", "proj-9");
    expect(eff.workflowStepTimeoutMs).toBe(7_000);
  });

  it("builtin id with no stored values → catalog defaults", async () => {
    const store = makeStore({});
    const eff = await resolveEffectiveSettingsById(store, "builtin:coding", "proj-9");
    expect(eff.requirePrApproval).toBe(false);
  });
});

// FNXC:PlannerOversight 2026-07-04-00:00: task override > workflow effective > "autonomous" default (FN-7509).
describe("resolveEffectivePlannerOversightLevel", () => {
  it("task override wins over workflow effective value", () => {
    expect(resolveEffectivePlannerOversightLevel("steer", "observe")).toBe("steer");
  });

  it("uses workflow effective value when no task override", () => {
    expect(resolveEffectivePlannerOversightLevel(undefined, "observe")).toBe("observe");
  });

  // FN-7521: exercise every PlannerOversightLevel enum value as a winning task
  // override (not just "steer"), so all four settable values are covered.
  it("task override 'off' wins over a workflow effective value of 'autonomous'", () => {
    expect(resolveEffectivePlannerOversightLevel("off", "autonomous")).toBe("off");
  });

  it("task override 'observe' wins over a workflow effective value of 'steer'", () => {
    expect(resolveEffectivePlannerOversightLevel("observe", "steer")).toBe("observe");
  });

  it("task override 'autonomous' wins over a workflow effective value of 'off'", () => {
    expect(resolveEffectivePlannerOversightLevel("autonomous", "off")).toBe("autonomous");
  });

  it("falls back to 'autonomous' when task override is an unknown/invalid string", () => {
    expect(resolveEffectivePlannerOversightLevel("bogus", "observe")).toBe("observe");
  });

  it("falls back to 'autonomous' when workflow effective value is an unknown/invalid string", () => {
    expect(resolveEffectivePlannerOversightLevel(undefined, "bogus")).toBe("autonomous");
  });

  it("falls back to 'autonomous' when both are unset", () => {
    expect(resolveEffectivePlannerOversightLevel(undefined, undefined)).toBe("autonomous");
  });

  it("falls back to 'autonomous' when both are null", () => {
    expect(resolveEffectivePlannerOversightLevel(null, null)).toBe("autonomous");
  });
});
