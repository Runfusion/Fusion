import { describe, expect, it } from "vitest";
import { getLatestFailedPreMergeReviewStep, type TaskDetail, type WorkflowIr } from "@fusion/core";

/*
FNXC:NoVerdictFailureDiagnostic 2026-11-04-06:02 (RUFU-381):
This file owns the acceptance contract for the cause-fidelity fix: a recorded no-verdict gate failure
may never carry an `output` indistinguishable from its own `status`. It is separate from
`workflow-graph-optional-group-no-feedback.test.ts` because that suite guards the older field-ABSENT
contract (Runfusion/Fusion#1946, `(no feedback captured)`) while this one guards the
field-PRESENT-but-worthless shape that fix left behind — two defects, two invariant tables, and the
operator's verification command names this file.

Every case drives a real `WorkflowGraphExecutor.run()` through its persistence sink, so what is pinned
is the RECORDED row and not a helper's return value. The attempt/budget numbers are asserted against
the ONE re-run-budget authority (`MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS`) rather than literals, so a
change to the cap fails this suite instead of quietly desynchronising the sentence operators read.
*/
import {
  countConsecutiveNoVerdictAttempts,
  formatNoVerdictCauseUndetected,
  NO_VERDICT_CAUSE_UNDETECTED_PHRASE,
  WorkflowGraphExecutor,
  type WorkflowNodeHandler,
} from "../workflows/workflow-graph-executor.js";
import { MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS } from "../merge/pre-merge-gate-reseed.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/*
 * Harness mirrors the two minimum IR shapes from `workflow-graph-optional-group-no-feedback.test.ts`
 * (each engine test file authors its own fixtures): one optional-group gate and one top-level
 * `source:"node"` gate — the two record surfaces this contract must hold on. `priorResults` seeds the
 * row's recorded step results so a test can stand where the re-seed lane stands after N earlier
 * verdict-less deaths; the recorder replaces the slot on every attempt and moves each replaced
 * terminal attempt into the surviving row's bounded `priorAttempts`, which is the field the attempt
 * count is read from.
 */
function taskWith(enabled: string[] | undefined, priorResults?: Array<Record<string, unknown>>): TaskDetail {
  return {
    id: "FN-CAUSE",
    enabledWorkflowSteps: enabled,
    ...(priorResults ? { workflowStepResults: priorResults } : {}),
  } as TaskDetail;
}

/** A single-node `code-review` optional-group between start/end — the optional-group record surface. */
function codeReviewGroupIr(): WorkflowIr {
  return {
    version: "v2",
    name: "code-review-cause-fidelity-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "code-review",
        kind: "optional-group",
        config: {
          name: "Code Review",
          defaultOn: true,
          template: {
            nodes: [{ id: "review", kind: "prompt", config: { prompt: "review" } }],
            edges: [],
          },
        },
      },
      { id: "after", kind: "prompt", config: { prompt: "after" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "code-review" },
      { from: "code-review", to: "after", condition: "success" },
      { from: "code-review", to: "end", condition: "failure" },
      { from: "after", to: "end" },
    ],
  };
}

/** A single top-level `gate` node (CE `source:"node"` skill gate) — the other record surface. */
function nodeGateIr(): WorkflowIr {
  return {
    version: "v2",
    name: "node-gate-cause-fidelity-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "gatecheck", kind: "gate", config: { prompt: "check", skillName: "security-gate" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "gatecheck" },
      { from: "gatecheck", to: "end" },
    ],
  };
}

/*
FNXC:NoVerdictFailureDiagnostic 2026-11-04-06:25 (RUFU-381):
The `(no feedback captured)` fix (Runfusion/Fusion#1946) closed the field-ABSENT shape but opened a
field-PRESENT-but-worthless one: `synthesizeNonVerdictFailureOutput` accepted the failure `value` as
a diagnostic detail, and the value a failed gate mints IS the word `"failed"`. Card RUFU-259's
`code-review` gate therefore recorded seven consecutive rows all reading
`Code Review failed before producing a verdict: failed` — non-empty output that named nothing, with no
attempt or budget context anywhere, so the only way to learn the card was looping was to reconstruct
the cadence from the store by hand.

The contract this table pins is: for EVERY recorded no-verdict gate failure shape, on BOTH record
surfaces (the optional-group terminal recorder and `source:"node"` gate progress), the `output` either
names a cause that is not the record's own status word, or states honestly that no cause was detected
and says where the card stands in the automatic re-run budget. The invariants the fix must NOT touch —
`status`, `verdict`, `verdictRequired`, and failed-gate eligibility — are asserted alongside, so the
diagnostic cannot be improved by changing what a failure MEANS.
*/

const NO_VERDICT_SENTENCE = /.+\((?:attempt \d+ of \d+; automatic re-run budget: \d+ of \d+ left|automatic re-run budget exhausted)\)$/;

/** One failed-gate outcome shape as it arrives at the record seam. */
interface FailureShape {
  name: string;
  value?: string;
  /** Text published on `node:<templateNodeId>:error`, the canonical cause carrier. */
  errorText?: string;
  /** What the record's `output` must do: name a cause, or state that none was detected. */
  expect: { kind: "cause"; cause: string } | { kind: "no-cause" };
  /**
   * Set when this shape produces no durable record on one surface, with the reason. `aborted` on a
   * top-level gate node is one: `isAbortNodeResult` intercepts it before the recorder runs, because an
   * engine-pause abort is a re-entrant interruption, not a gate failure — so there is no output to
   * name. The optional-group surface has no such interception and does record it.
   */
  unrecordedOn?: "node";
}

const FAILURE_SHAPES: FailureShape[] = [
  // The defect: a detail equal to the record's own status is a restatement, not a cause.
  { name: "status echo", value: "failed", expect: { kind: "no-cause" } },
  { name: "empty value", value: "", expect: { kind: "no-cause" } },
  { name: "absent value", expect: { kind: "no-cause" } },
  // Legitimate categorizations survive: the deny-list is the bare status word, not a vocabulary.
  { name: "aborted", value: "aborted", expect: { kind: "cause", cause: "aborted" }, unrecordedOn: "node" },
  { name: "exception", value: "exception", expect: { kind: "cause", cause: "exception" } },
  { name: "malformed", value: "malformed", expect: { kind: "cause", cause: "malformed" } },
  { name: "advisory_failure", value: "advisory_failure", expect: { kind: "cause", cause: "advisory_failure" } },
  { name: "plugin-node-handler-error", value: "plugin-node-handler-error", expect: { kind: "cause", cause: "plugin-node-handler-error" } },
  // A real cause on the canonical carrier wins over both the echo and the no-cause sentence.
  {
    name: "echo plus real error",
    value: "failed",
    errorText: "provider returned 502",
    expect: { kind: "cause", cause: "provider returned 502" },
  },
  {
    name: "no value plus real error",
    errorText: "workflow step timed out after 900000ms",
    expect: { kind: "cause", cause: "workflow step timed out after 900000ms" },
  },
];

interface RecordSurface {
  name: string;
  gateStepId: string;
  expectedSource: "optional-group" | "node";
  run: (shape: FailureShape, priorResults?: Array<Record<string, unknown>>) => Promise<Record<string, unknown> | undefined>;
}

const recordSurfaces: RecordSurface[] = [
  {
    name: 'source:"optional-group"',
    gateStepId: "code-review",
    expectedSource: "optional-group",
    run: async (shape, priorResults) => {
      const records: Array<Record<string, unknown>> = [];
      const handler: WorkflowNodeHandler = async (node) => {
        if (node.id !== "review") return { outcome: "success" };
        return {
          outcome: "failure",
          ...(shape.value !== undefined ? { value: shape.value } : {}),
          ...(shape.errorText ? { contextPatch: { "node:review:error": shape.errorText } } : {}),
        };
      };
      const executor = new WorkflowGraphExecutor({
        handlers: { prompt: handler },
        recordWorkflowStepResult: async (_taskId, result) => {
          records.push(result as unknown as Record<string, unknown>);
        },
      });
      await executor.run(taskWith(["code-review"], priorResults), settingsOn(), codeReviewGroupIr());
      return records.find((r) => r.workflowStepId === "code-review" && r.status !== "pending");
    },
  },
  {
    name: 'source:"node"',
    gateStepId: "gatecheck",
    expectedSource: "node",
    run: async (shape, priorResults) => {
      const records: Array<Record<string, unknown>> = [];
      const handler: WorkflowNodeHandler = async () => ({
        outcome: "failure",
        ...(shape.value !== undefined ? { value: shape.value } : {}),
        ...(shape.errorText ? { contextPatch: { "node:gatecheck:error": shape.errorText } } : {}),
      });
      const executor = new WorkflowGraphExecutor({
        handlers: { gate: handler },
        recordWorkflowStepResult: async (_taskId, result) => {
          records.push(result as unknown as Record<string, unknown>);
        },
      });
      await executor.run(taskWith(undefined, priorResults), settingsOn(), nodeGateIr());
      return records.find((r) => r.workflowStepId === "gatecheck" && r.status !== "pending");
    },
  },
];

/** A prior verdict-less failure row for the same gate, as the recorder's upsert leaves it. */
function priorNoVerdictAttempt(day: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowStepId: "__GATE__",
    workflowStepName: "Code Review",
    status: "failed",
    startedAt: `2026-11-0${day}T00:00:00.000Z`,
    completedAt: `2026-11-0${day}T00:10:00.000Z`,
    output: "Code Review failed before producing a verdict: failed",
    ...overrides,
  };
}

describe.each(recordSurfaces)("no-verdict failure output contract — $name (RUFU-381)", (surface) => {
  it.each(FAILURE_SHAPES)("shape '$name' names a cause or states that none was detected", async (shape) => {
    if (shape.unrecordedOn === surface.expectedSource) {
      // Proof the exclusion is the interception, not a missing record: the run stops at the node.
      const records: Array<Record<string, unknown>> = [];
      const handler: WorkflowNodeHandler = async () => ({ outcome: "failure", value: shape.value });
      const executor = new WorkflowGraphExecutor({
        handlers: { gate: handler },
        recordWorkflowStepResult: async (_taskId, result) => {
          records.push(result as unknown as Record<string, unknown>);
        },
      });
      await executor.run(taskWith(undefined), settingsOn(), nodeGateIr());
      expect(records.filter((r) => r.workflowStepId === surface.gateStepId && r.status === "failed")).toEqual([]);
      return;
    }
    const record = await surface.run(shape);

    expect(record, `surface ${surface.name} shape ${shape.name}`).toBeDefined();
    // Invariants the fix must NOT touch: it may only improve `output`.
    expect(record!.status).toBe("failed");
    expect(record!.verdict).toBeUndefined();
    expect(record!.source).toBe(surface.expectedSource);

    const text = String(record!.output);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toBe("(no feedback captured)");

    if (shape.expect.kind === "cause") {
      expect(text).toContain(shape.expect.cause);
      expect(text).not.toMatch(/verdict: failed$/);
      expect(text).not.toMatch(NO_VERDICT_SENTENCE);
    } else {
      expect(text).toContain(NO_VERDICT_CAUSE_UNDETECTED_PHRASE);
      expect(text).toMatch(NO_VERDICT_SENTENCE);
      // The whole point: the echo is gone, so two consecutive deaths never read identically.
      expect(text).not.toMatch(/verdict: failed$/);
    }

    // Eligibility for the failed-gate recovery and operator-bypass surfaces is unchanged by the text.
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [record] as never }))
      .toMatchObject({ workflowStepId: surface.gateStepId, status: "failed" });
  });

  it("quotes the live re-run budget constant instead of a second number", async () => {
    const record = await surface.run({ name: "echo", value: "failed", expect: { kind: "no-cause" } });
    const text = String(record!.output);
    expect(text).toContain(`attempt 1 of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS + 1}`);
    expect(text).toContain(`automatic re-run budget: ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS} of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS} left`);
  });

  it("counts the attempts already on the row and reports the remaining budget", async () => {
    const priors = [1, 2].map((day) => priorNoVerdictAttempt(day, { workflowStepId: surface.gateStepId }));
    const record = await surface.run({ name: "echo", value: "failed", expect: { kind: "no-cause" } }, priors);
    const text = String(record!.output);
    expect(text).toContain(`attempt 3 of ${MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS + 1}`);
    expect(text).toContain("automatic re-run budget: 1 of 3 left");
  });

  it("says the budget is exhausted once the automatic re-runs are spent", async () => {
    const priors = [1, 2, 3].map((day) => priorNoVerdictAttempt(day, { workflowStepId: surface.gateStepId }));
    const record = await surface.run({ name: "echo", value: "failed", expect: { kind: "no-cause" } }, priors);
    expect(String(record!.output)).toContain("automatic re-run budget exhausted");
  });

  it("stops counting at the last settled attempt instead of counting the gate's whole lifetime", async () => {
    // Newest first: a verdict-less death, then an authored REVISE, then an older verdict-less death.
    // Only the newest death belongs to this episode; the oldest predates the settled REVISE.
    const priors = [
      priorNoVerdictAttempt(3, { workflowStepId: surface.gateStepId }),
      priorNoVerdictAttempt(2, { workflowStepId: surface.gateStepId, verdict: "REVISE" }),
      priorNoVerdictAttempt(1, { workflowStepId: surface.gateStepId }),
    ];
    const record = await surface.run({ name: "echo", value: "failed", expect: { kind: "no-cause" } }, priors);
    const text = String(record!.output);
    expect(text).toContain("attempt 2 of");
    expect(text).not.toContain("attempt 4 of");
  });

  it("treats an operator bypass waiver as the end of the episode", async () => {
    const priors = [
      priorNoVerdictAttempt(3, { workflowStepId: surface.gateStepId }),
      priorNoVerdictAttempt(2, { workflowStepId: surface.gateStepId, status: "skipped", bypassedBy: "operator" }),
      priorNoVerdictAttempt(1, { workflowStepId: surface.gateStepId }),
    ];
    const record = await surface.run({ name: "echo", value: "failed", expect: { kind: "no-cause" } }, priors);
    const text = String(record!.output);
    expect(text).toContain("attempt 2 of");
    expect(text).not.toContain("attempt 4 of");
  });
});

describe("countConsecutiveNoVerdictAttempts (RUFU-381)", () => {
  const gateId = "code-review";

  it("counts nothing without record context, and reports the count as unavailable", () => {
    expect(countConsecutiveNoVerdictAttempts(undefined, gateId)).toBe(0);
    expect(formatNoVerdictCauseUndetected(undefined)).toBe(`${NO_VERDICT_CAUSE_UNDETECTED_PHRASE} (attempt count unavailable)`);
  });

  it("walks the current row's bounded priorAttempts history, newest first", () => {
    const results = [{
      workflowStepId: gateId,
      workflowStepName: "Code Review",
      status: "failed",
      startedAt: "2026-11-04T00:00:00.000Z",
      completedAt: "2026-11-04T00:10:00.000Z",
      priorAttempts: [1, 2, 3].map((day) => ({
        workflowStepId: gateId,
        workflowStepName: "Code Review",
        status: "failed" as const,
        completedAt: `2026-11-0${day}T00:10:00.000Z`,
      })),
    }] as never;
    expect(countConsecutiveNoVerdictAttempts(results, gateId)).toBe(4);
  });

  it("stops at a remediation-archived carrier, which settled the gate by another route", () => {
    const results = [{
      workflowStepId: gateId,
      workflowStepName: "Code Review",
      status: "failed",
      supersededAt: "2026-11-04T00:10:00.000Z",
      completedAt: "2026-11-04T00:10:00.000Z",
      priorAttempts: [{
        workflowStepId: gateId,
        workflowStepName: "Code Review",
        status: "skipped" as const,
        remediationArchivedAt: "2026-11-03T00:00:00.000Z",
        remediationArchivedFromStatus: "failed" as const,
        completedAt: "2026-11-03T00:10:00.000Z",
      }],
    }] as never;
    expect(countConsecutiveNoVerdictAttempts(results, gateId)).toBe(1);
  });

  it("ignores an in-flight pending lease instead of counting it", () => {
    const results = [{
      workflowStepId: gateId,
      workflowStepName: "Code Review",
      status: "pending",
      startedAt: "2026-11-05T00:00:00.000Z",
    }, {
      workflowStepId: gateId,
      workflowStepName: "Code Review",
      status: "failed",
      completedAt: "2026-11-04T00:10:00.000Z",
    }] as never;
    expect(countConsecutiveNoVerdictAttempts(results, gateId)).toBe(1);
  });

  it("never counts a row belonging to a different gate", () => {
    const results = [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "failed",
      completedAt: "2026-11-04T00:10:00.000Z",
    }] as never;
    expect(countConsecutiveNoVerdictAttempts(results, gateId)).toBe(0);
  });
});

describe("the RUFU-259 incident shape stays distinguishable across repeats (RUFU-381)", () => {
  it("records a different diagnostic on each of four consecutive no-cause deaths", async () => {
    const seen: string[] = [];
    // The recorder's upsert replaces the slot and moves each replaced attempt into the surviving
    // row's bounded `priorAttempts` (snapshots never nest), which is what the count walks.
    const history: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const priors = history.length
        ? [{ ...history[0], priorAttempts: history.slice(1, 6) }]
        : [];
      const records: Array<Record<string, unknown>> = [];
      const handler: WorkflowNodeHandler = async (node) => node.id === "review"
        ? { outcome: "failure", value: "failed" }
        : { outcome: "success" };
      const executor = new WorkflowGraphExecutor({
        handlers: { prompt: handler },
        recordWorkflowStepResult: async (_taskId, result) => {
          records.push(result as unknown as Record<string, unknown>);
        },
      });
      await executor.run(taskWith(["code-review"], priors), settingsOn(), codeReviewGroupIr());
      const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status === "failed");
      expect(terminal).toBeDefined();
      seen.push(String(terminal!.output));
      history.unshift({
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "failed",
        startedAt: `2026-11-0${attempt + 1}T00:00:00.000Z`,
        completedAt: `2026-11-0${attempt + 1}T00:10:00.000Z`,
      });
    }

    expect(new Set(seen).size).toBe(4);
    expect(seen[0]).toContain("attempt 1 of");
    expect(seen[3]).toContain("attempt 4 of");
    expect(seen[3]).toContain("automatic re-run budget exhausted");
  });
});
