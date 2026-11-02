/*
FNXC:PlanPremises 2026-09-16-04:08:
RUFU-246 Step 4 — a terminally parked plan-premise card must be invisible to the scheduled hold
release sweep: the skip sits at the top of the candidate loop, BEFORE the per-task IR resolve, so a
parked card draws no IR definition read, no PROMPT.md read, no premise evaluation, no reservation,
no refusal log, and no audit row on later passes. The parked card selects its own workflow, so
`getWorkflowDefinition` call ids are per-workflow evidence: resolving only the control's workflow is
the direct proof the park skipped before IR resolution, and without the skip the park would also
surface as a held `manual-only` candidate. The control card — whose IR resolve proves the candidate
loop iterated — makes the assertions non-vacuous in every environment. (The shared-harness
sweep-release failures that predate this task make the control's MOVE environment-dependent, so no
release outcome is asserted.)
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { runHoldReleaseSweep } from "../execution/hold-release.js";
import { PLAN_PREMISE_EXHAUSTED_PREFIX } from "../execution/plan-premise-ladder.js";

const PARK_WORKFLOW_ID = "custom:premise-park";
const CONTROL_WORKFLOW_ID = "custom:premise-park-control";

function holdIr(id: string, release: "capacity" | "manual"): WorkflowIr {
  return {
    version: "v2",
    id,
    name: id,
    nodes: [],
    edges: [],
    columns: [
      { id: "hold", name: "Hold", traits: [{ trait: "hold", config: { release } }] },
      { id: "doing", name: "Doing", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
  } as unknown as WorkflowIr;
}

function parkedTask(): Task {
  return {
    id: "FN-PARK",
    title: "parked",
    description: "",
    column: "hold",
    status: "failed",
    error: `${PLAN_PREMISE_EXHAUSTED_PREFIX} literal not found in file — the same plan premises were refused three times in a row; rewrite the plan against the current code or delete this card.`,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceMetadata: {
      planPremiseRejection: {
        signature: "sig",
        refusalCount: 3,
        lastDetail: "literal not found in file",
        lastAt: "2026-01-01T00:00:00.000Z",
        escalation: "park",
        detailHash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    },
  } as unknown as Task;
}

describe("hold-release sweep skips the premise terminal park before resolving its IR", () => {
  it("evaluates only the control workflow while the parked card draws no read or write", async () => {
    const parked = parkedTask();
    const control = {
      id: "FN-CTRL",
      title: "control",
      description: "",
      column: "hold",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    } as Task;
    const selections: Record<string, { workflowId: string; stepIds: string[] }> = {
      [parked.id]: { workflowId: PARK_WORKFLOW_ID, stepIds: [] },
      [control.id]: { workflowId: CONTROL_WORKFLOW_ID, stepIds: [] },
    };
    const resolvedWorkflowIds: string[] = [];
    const updateTask = vi.fn(async () => undefined);
    const updateTaskAtomic = vi.fn(async () => undefined);
    const logEntryOnce = vi.fn(async () => undefined);
    const moveTaskIf = vi.fn(async (id: string, column: string) => {
      const task = id === parked.id ? parked : control;
      task.column = column;
      return { task, moved: true };
    });
    const store = {
      getRootDir: () => process.cwd(),
      getSettings: vi.fn(async () => ({ maxConcurrent: 5 })),
      listTasks: vi.fn(async () => [parked, control]),
      getTask: vi.fn(async (id: string) => (id === parked.id ? parked : id === control.id ? control : null)),
      moveTaskIf,
      logEntry: vi.fn(async () => undefined),
      logEntryOnce,
      updateTask,
      updateTaskAtomic,
      recordRunAuditEvent: vi.fn(async () => undefined),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      getTaskWorkflowSelection: vi.fn((id: string) => selections[id]!),
      getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => selections[id]!),
      getWorkflowDefinition: vi.fn(async (workflowId: string) => {
        resolvedWorkflowIds.push(workflowId);
        return { ir: holdIr(workflowId, workflowId === CONTROL_WORKFLOW_ID ? "capacity" : "manual") };
      }),
    } as unknown as TaskStore;

    const result = await runHoldReleaseSweep(store, { now: () => 1_000_000 });

    // The park skipped before the per-task IR resolve: only the control's workflow was loaded.
    // Without the skip the park (older, evaluated first) resolves first and its workflow id
    // appears here — this is the red-check-sensitive signal, environment-independent.
    expect(resolvedWorkflowIds).not.toContain(PARK_WORKFLOW_ID);
    expect(resolvedWorkflowIds).toContain(CONTROL_WORKFLOW_ID);
    // Without the skip the park surfaces as a held `manual-only` candidate (its workflow's hold
    // release kind); with the skip no held/released entry may carry its id in any environment.
    expect(result.held.some((held: { taskId: string }) => held.taskId === parked.id)).toBe(false);
    expect(result.released).not.toContain(parked.id);
    // Refuse-to-touch: the terminal park row survives untouched by any sweep pass.
    expect(parked.column).toBe("hold");
    expect(parked.status).toBe("failed");
    expect(parked.error).toContain(PLAN_PREMISE_EXHAUSTED_PREFIX);
    expect(parked.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 3, escalation: "park" });
    /*
    FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
    This guard read as a blanket "the sweep performed no updateTask call anywhere", which the sweep could
    satisfy only while it wrote nothing at all. A held capacity candidate now also records its durable
    WIP-admission marker, so the blanket form would have laundered a real requirement (the terminal park is
    refuse-to-touch) into a prohibition on an unrelated write. The invariant is now asserted ABOUT the park
    rather than about the world: no write, atomic write, or once-log may name the parked id.
    */
    const namesPark = (calls: readonly unknown[]): boolean => calls.every((call) => (call as unknown[])[0] !== parked.id);
    expect(namesPark(updateTask.mock.calls)).toBe(true);
    expect(namesPark(updateTaskAtomic.mock.calls)).toBe(true);
    expect(namesPark(logEntryOnce.mock.calls)).toBe(true);
    // No move was ever attempted for the park (the control's move, if any, is environment-dependent).
    expect(moveTaskIf.mock.calls.every((call: unknown[]) => call[0] !== parked.id)).toBe(true);
  });
});
