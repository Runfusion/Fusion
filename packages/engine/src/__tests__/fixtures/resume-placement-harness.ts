/*
FNXC:ResumePlacement 2026-11-01-20:20 (RUFU-300):
Shared harness for the "resume a run AFTER a passed gate" legs.

Three files assert halves of the same invariant (placement, the two-actor release chain, pin/column
coherence) and all three need the SAME seeded card: RUFU-292's recorded row — a released
`plan-review`, the card still in the planning lane, a pin naming the execution lane, and a fully
parsed but untouched 9-step ledger. Duplicating that seed across files is how one fixture line later
explains thirty failures, so it lives here once.

Everything is in-memory: no real AI, no real worktree, no real network, no timers.
*/
import { vi } from "vitest";
import "@fusion/core"; // registers built-in traits into the shared registry
import {
  computeWorkflowIrPin,
  getBuiltinWorkflow,
  parseWorkflowIr,
  type TaskDetail,
  type TaskStep,
  type WorkflowIr,
} from "@fusion/core";

import type { WorkflowRuntimePrimitives } from "../../execution/runtime-primitives.js";
import {
  createWorkflowColumnBoundary,
  type WorkflowColumnBoundaryAuditEvent,
} from "../../workflows/workflow-column-boundary.js";
import { WorkflowGraphExecutor } from "../../workflows/workflow-graph-executor.js";

/** The DEFAULT workflow IR (`builtin:coding` maps to the stepwise-final-review shape). */
export const codingIr: WorkflowIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

/** A 9-step `## Steps` document — RUFU-292's parsed ledger came from a prompt of exactly this size. */
export const PROMPT = "# Task\n\n## Steps\n\n"
  + Array.from({ length: 9 }, (_unused, index) => `### Step ${index}: Step ${index}\n- [ ] do it ${index}\n`).join("");

export const PINNED_STEPS: TaskStep[] = Array.from({ length: 9 }, (_unused, index) => ({
  name: `Step ${index}`,
  status: "pending" as const,
}));

export function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } } as never;
}

/**
 * RUFU-292's recorded state, seeded verbatim: released `plan-review`, still in the planning lane,
 * pin naming the execution lane, a fully-parsed-but-untouched 9-step ledger.
 */
export function rufu292Task(over: Partial<TaskDetail> = {}): TaskDetail {
  const pin = computeWorkflowIrPin(codingIr, "parse");
  return {
    id: "RUFU-292-SEED",
    title: "Passnuty Plan Review sa neda dobehnut",
    description: "",
    prompt: PROMPT,
    column: "todo",
    dependencies: [],
    steps: PINNED_STEPS.map((step) => ({ ...step })),
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed",
      verdict: "APPROVE_WITH_NOTES",
      completedAt: "2026-09-24T14:41:36.612Z",
    }],
    workflowIrPin: pin.irHash,
    workflowIrPinNodeId: "parse",
    workflowIrPinColumnId: "in-progress",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...over,
  } as unknown as TaskDetail;
}

/** Records which runtime effects a node handler reached for — the replay detector. */
export function recordingPrimitives(calls: string[]): WorkflowRuntimePrimitives {
  const ok = { outcome: "success" as const };
  return {
    prepareWorktree: async () => ({ outcome: "success", data: { worktreePath: "/memory/worktree" } }),
    readArtifact: async (_c: unknown, _t: unknown, key: string) => (key === "PROMPT.md" ? PROMPT : undefined),
    writeArtifact: async (_c: unknown, _t: unknown, key: string) => ({ outcome: "success", data: { key } }),
    runPlanningSession: async () => { calls.push("plan"); return { outcome: "success", data: { approved: true, artifactKeys: ["PROMPT.md"] } }; },
    runCodingSession: async () => { calls.push("execute"); return { outcome: "success", data: { taskDone: true, modifiedFiles: [] } }; },
    runTaskStep: async () => { calls.push("step-execute"); return { outcome: "success", baselineSha: "b", checkpointId: "c" }; },
    resetTaskStep: async () => ({ ok: true }),
    runReview: async () => { calls.push("review"); return { outcome: "success", data: { verdict: "APPROVE" } }; },
    runVerification: async () => ({ outcome: "success", data: { verdict: "skipped" } }),
    updateSteps: async (_c: unknown, target: TaskDetail, steps: TaskStep[]) => {
      calls.push("updateSteps");
      target.steps = steps;
      return { outcome: "success", data: { count: steps.length } };
    },
    transitionTask: async () => ok,
    requestMerge: async () => ({ outcome: "success", value: "merged", data: { status: "merged" } }),
    abortRun: async () => ok,
    audit: () => undefined,
  } as unknown as WorkflowRuntimePrimitives;
}

export function parseStepsDeps() {
  return {
    readArtifact: async (_target: unknown, key: string) => (key === "PROMPT.md" ? PROMPT : undefined),
    writeSteps: async (target: TaskDetail, steps: TaskStep[]) => {
      target.steps = steps;
    },
  };
}

/** A minimal recording store for the pin writes the column boundary performs at node entry. */
export function recordingStore(task: TaskDetail) {
  const pins: Array<{ nodeId?: string | null; columnId?: string | null }> = [];
  const row = { ...task };
  const store = {
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(row, patch);
      if ("workflowIrPinNodeId" in patch) {
        pins.push({
          nodeId: patch.workflowIrPinNodeId as string | null | undefined,
          columnId: patch.workflowIrPinColumnId as string | null | undefined,
        });
      }
      return row;
    }),
    getTask: vi.fn(async () => row),
  };
  return { store, row, pins };
}

export interface WiredHarness {
  boundary: ReturnType<typeof createWorkflowColumnBoundary>;
  executor: WorkflowGraphExecutor;
  moves: Array<{ toColumn: string; fromColumn: string; nodeId: string }>;
  audit: WorkflowColumnBoundaryAuditEvent[];
  pins: Array<{ nodeId?: string | null; columnId?: string | null }>;
  row: TaskDetail;
  calls: string[];
}

/*
A graph run WITH a column boundary. `workflow-graph-entry-contract.test.ts` deliberately constructs its
executor without one, so a column move is not merely illegal there — it is unobservable. Any leg that
claims something about a crossing has to wire this, and KTD-2 pins that the crossing it observes is a
REFUSAL: `moves` must stay empty on a hold→wip boundary.
*/
export function wiredHarness(task: TaskDetail, over: {
  initialColumn?: string;
  pinnedNodeId?: string;
  resumePlacementSinks?: ConstructorParameters<typeof WorkflowGraphExecutor>[0]["resumePlacementSinks"];
} = {}): WiredHarness {
  const initialColumn = over.initialColumn ?? task.column;
  const pinnedNodeId = over.pinnedNodeId ?? "parse";
  const { store, row, pins } = recordingStore(task);
  const moves: WiredHarness["moves"] = [];
  const audit: WorkflowColumnBoundaryAuditEvent[] = [];
  const calls: string[] = [];
  const boundary = createWorkflowColumnBoundary({
    taskId: task.id,
    workflowId: "builtin:coding",
    ir: codingIr,
    initialColumn,
    moveTask: async (toColumn, ctx) => { moves.push({ toColumn, ...ctx }); },
    emitAudit: (event) => { audit.push(event); },
    pinNodeEntry: (pin) => {
      void store.updateTask(task.id, {
        workflowIrPin: pin.irHash,
        workflowIrPinNodeId: pin.nodeId,
        workflowIrPinColumnId: pin.columnId ?? null,
      });
    },
    priorPin: computeWorkflowIrPin(codingIr, pinnedNodeId),
  });
  const executor = new WorkflowGraphExecutor({
    primitives: recordingPrimitives(calls),
    parseStepsDeps: parseStepsDeps(),
    columnBoundary: boundary,
    ...(over.resumePlacementSinks ? { resumePlacementSinks: over.resumePlacementSinks } : {}),
  } as never);
  return { boundary, executor, moves, audit, pins, row, calls };
}
