import { describe, expect, it } from "vitest";
import {
  parseWorkflowIr,
  serializeWorkflowIr,
  downgradeIrToV1IfPure,
  WorkflowIrError,
} from "../workflows/workflow-ir.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-final-review-coding-workflow-ir.js";
import { getBuiltinWorkflow } from "../workflows/builtin-workflows.js";
import {
  BUILTIN_MOVED_WORKFLOW_SETTINGS,
  BUILTIN_WORKFLOW_SETTINGS,
} from "../workflows/builtin-workflow-settings.js";
import { DEFAULT_PROJECT_SETTINGS } from "../types.js";
import type {
  WorkflowIrV2,
  WorkflowIrNode,
  WorkflowSettingDefinition,
} from "../workflows/workflow-ir-types.js";

const startEnd: WorkflowIrNode[] = [
  { id: "start", kind: "start" },
  { id: "end", kind: "end" },
];

function withSettings(settings: WorkflowSettingDefinition[]): WorkflowIrV2 {
  return {
    version: "v2",
    name: "test",
    columns: [],
    nodes: startEnd,
    edges: [{ from: "start", to: "end" }],
    settings,
  };
}

describe("parseWorkflowIr — workflow settings declarations (U1)", () => {
  it("parses and round-trips a valid declaration of each type", () => {
    const settings: WorkflowSettingDefinition[] = [
      { id: "s-string", name: "S", type: "string", default: "x" },
      { id: "s-text", name: "T", type: "text", default: "long" },
      { id: "s-number", name: "N", type: "number", default: 42 },
      { id: "s-boolean", name: "B", type: "boolean", default: true },
      {
        id: "s-enum",
        name: "E",
        type: "enum",
        default: "a",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      {
        id: "s-multi",
        name: "M",
        type: "multi-enum",
        default: ["a"],
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        render: { widget: "chips" },
      },
    ];
    const parsed = parseWorkflowIr(withSettings(settings)) as WorkflowIrV2;
    expect(parsed.settings).toEqual(settings);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it("allows a declaration with no default and a description", () => {
    const parsed = parseWorkflowIr(
      withSettings([
        { id: "lane", name: "Lane", type: "string", description: "a model lane" },
      ]),
    ) as WorkflowIrV2;
    expect(parsed.settings?.[0].default).toBeUndefined();
  });

  it("rejects duplicate setting ids", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([
          { id: "dup", name: "A", type: "string" },
          { id: "dup", name: "B", type: "string" },
        ]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects an empty id", () => {
    expect(() =>
      parseWorkflowIr(withSettings([{ id: "", name: "A", type: "string" }])),
    ).toThrow(WorkflowIrError);
  });

  it("rejects an unknown type", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([{ id: "x", name: "A", type: "date" as never }]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects an enum without options", () => {
    expect(() =>
      parseWorkflowIr(withSettings([{ id: "x", name: "A", type: "enum" }])),
    ).toThrow(WorkflowIrError);
  });

  it("rejects options on a non-enum type", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([
          { id: "x", name: "A", type: "number", options: [{ value: "a", label: "A" }] },
        ]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects duplicate option values", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([
          {
            id: "x",
            name: "A",
            type: "enum",
            options: [
              { value: "a", label: "A" },
              { value: "a", label: "A2" },
            ],
          },
        ]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects a disallowed render widget", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([
          { id: "x", name: "A", type: "string", render: { widget: "slider" as never } },
        ]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects a default violating its own type (number with string)", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([{ id: "x", name: "A", type: "number", default: "x" }]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects a default violating boolean type", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([{ id: "x", name: "A", type: "boolean", default: "true" }]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects an enum default not among options", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([
          {
            id: "x",
            name: "A",
            type: "enum",
            default: "c",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("rejects a multi-enum default containing an unknown option", () => {
    expect(() =>
      parseWorkflowIr(
        withSettings([
          {
            id: "x",
            name: "A",
            type: "multi-enum",
            default: ["a", "c"],
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ]),
      ),
    ).toThrow(WorkflowIrError);
  });

  it("does not downgrade an IR with settings present to v1", () => {
    const parsed = parseWorkflowIr(
      withSettings([{ id: "x", name: "A", type: "string", default: "v" }]),
    );
    const down = downgradeIrToV1IfPure(parsed);
    expect(down.version).toBe("v2");
  });
});

describe("built-in workflow settings parity anchor (U1, R4)", () => {
  it("the built-in coding workflow declares the full workflow settings catalog", () => {
    const builtin = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    const declaredIds = new Set((builtin.settings ?? []).map((s) => s.id));
    for (const setting of BUILTIN_WORKFLOW_SETTINGS) {
      expect(declaredIds.has(setting.id)).toBe(true);
    }
    expect(builtin.settings).toEqual(BUILTIN_WORKFLOW_SETTINGS);
    expect(getBuiltinWorkflow("builtin:coding")!.ir).toBe(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR);
    expect(getBuiltinWorkflow("builtin:legacy-coding")!.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect((getBuiltinWorkflow("builtin:coding")!.ir as WorkflowIrV2).settings).toEqual(BUILTIN_WORKFLOW_SETTINGS);
  });

  it("the moved-key catalog has left DEFAULT_PROJECT_SETTINGS (U4 hard-move) and pins current built-in defaults", () => {
    const legacy = DEFAULT_PROJECT_SETTINGS as Record<string, unknown>;
    // Post-U4 hard-move: every catalog key has been REMOVED from
    // DEFAULT_PROJECT_SETTINGS (the type-vs-schema split keeps the type field but
    // drops the default literal), so the legacy object no longer carries them.
    for (const setting of BUILTIN_MOVED_WORKFLOW_SETTINGS) {
      expect(Object.prototype.hasOwnProperty.call(legacy, setting.id)).toBe(false);
    }
    // The declaration defaults are now the single source of truth; pin current
    // built-in values explicitly so they can never silently drift from engine
    // read-site fallbacks or workflow editor display.
    const expectedDefaults: Record<string, unknown> = {
      workflowStepTimeoutMs: 900_000,
      workflowStepScopeEnforcement: "block",
      planOnlyScopeLeakEnforcement: "warn",
      workflowRevisionForkOnScopeMismatch: true,
      strictScopeEnforcement: false,
      runStepsInNewSessions: false,
      maxParallelSteps: 2,
      buildRetryCount: 0,
      verificationFixRetries: 3,
      maxPostReviewFixes: 3,
      requirePrApproval: false,
      requirePlanApproval: false,
      reviewHandoffPolicy: "disabled",
      maxReviewerContextRetries: 2,
      maxReviewerFallbackRetries: 2,
      reflectionEnabled: false,
      // Per-phase model lanes have undefined legacy defaults → declaration omits default.
    };
    for (const setting of BUILTIN_MOVED_WORKFLOW_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(expectedDefaults, setting.id)) {
        expect(setting.default).toStrictEqual(expectedDefaults[setting.id]);
      } else {
        // Model-lane keys: no default.
        expect(setting.default).toBeUndefined();
      }
    }
  });

  it("buildTimeoutMs is NOT in the catalog and stays a plain project setting", () => {
    const declaredIds = new Set(BUILTIN_WORKFLOW_SETTINGS.map((s) => s.id));
    expect(declaredIds.has("buildTimeoutMs")).toBe(false);
    expect((DEFAULT_PROJECT_SETTINGS as Record<string, unknown>).buildTimeoutMs).toBe(300_000);
  });
});
