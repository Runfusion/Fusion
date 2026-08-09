/*
FNXC:PlanApproval 2026-08-01-04:39:
`awaitingApprovalReason` was defined in persistence (defineTaskColumn) and serialization, and two
writers depend on it — the executor's Plan Review replan-cap park writes `"plan-review-replan-cap"`
so the board can say "non-converging Plan Review loop, human decision needed", and the triage manual
plan gate writes an explicit null so a stale reason never survives into a routine manual hold. But
`updateTaskUnlockedImpl`'s field-by-field merge never applied the key, so EVERY write silently
dropped it: FN-8647 looped plan → REVISE → replan 15 times, hit the hard cap, and parked with a
generic "needs approval" that gave the operator no hint it was a cap escalation.

These tests pin the merge contract: set persists, null clears, a status write that moves the task
OFF `awaiting-approval` without addressing the reason auto-clears it (an approved or replanned card
must not carry a stale escalation reason into its next park), and unrelated updates leave it alone.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";
import { updateTaskUnlockedImpl } from "../task-store/task-update.js";

function harness(task: Partial<Task>) {
  const row = {
    id: "FN-1", column: "todo", dependencies: [], steps: [], log: [], status: null,
    title: "t", description: "d", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...task,
  } as unknown as Task;
  const store = {
    taskDir: () => "/tmp/does-not-matter",
    readTaskJson: async () => row,
    writeTaskJson: vi.fn(async () => undefined),
    atomicWriteTaskJson: vi.fn(async () => undefined),
    syncAgentTaskLinkOnReassignment: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({})),
    assertNoDependencyCycle: vi.fn(async () => undefined),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async () => undefined,
    getWorkflowDefinition: async () => undefined,
    emit: vi.fn(),
    isWatching: false,
    taskCache: new Map(),
  } as Record<string, unknown>;
  // Same maintenance-proof pattern as task-update-lanes-resolved.test.ts: unlisted store methods
  // answer with async no-ops; only return values the assertions depend on are stubbed explicitly.
  const proxied = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as unknown as TaskStore;
  return { store: proxied, row };
}

const run = (store: TaskStore, updates: Record<string, unknown>) =>
  updateTaskUnlockedImpl(store, "FN-1", updates as never).catch((err: unknown) => {
    if (err instanceof Error && /ENOENT|EACCES|no such file/i.test(err.message)) return null;
    throw err;
  });

describe("awaitingApprovalReason survives updateTask", () => {
  it("persists the replan-cap escalation reason alongside the awaiting-approval park", async () => {
    // Pre-fix this was silently dropped and the board showed a generic "needs approval".
    const { store, row } = harness({ status: "needs-replan" });

    await run(store, { status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" });

    expect(row.status).toBe("awaiting-approval");
    expect(row.awaitingApprovalReason).toBe("plan-review-replan-cap");
  });

  it("persists the structured PR policy-block reason alongside its human hold", async () => {
    const { store, row } = harness({ status: null });

    await run(store, { status: "awaiting-approval", awaitingApprovalReason: "merge-blocked-by-policy" });

    expect(row.status).toBe("awaiting-approval");
    expect(row.awaitingApprovalReason).toBe("merge-blocked-by-policy");
  });

  it("clears the reason on an explicit null (the manual plan gate's stale-reason guard)", async () => {
    const { store, row } = harness({
      status: "needs-replan",
      awaitingApprovalReason: "plan-review-replan-cap",
    } as Partial<Task>);

    await run(store, { status: "awaiting-approval", awaitingApprovalReason: null });

    expect(row.status).toBe("awaiting-approval");
    expect(row.awaitingApprovalReason).toBeUndefined();
  });

  it("auto-clears a stored reason when a status write leaves awaiting-approval", async () => {
    // approve-plan / replan writers clear status without knowing about the reason field; the merge
    // must not let the escalation reason leak into the card's next lifecycle stage.
    const { store, row } = harness({
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    } as Partial<Task>);

    await run(store, { status: "queued" });

    expect(row.status).toBe("queued");
    expect(row.awaitingApprovalReason).toBeUndefined();
  });

  it("leaves a stored reason untouched on unrelated updates", async () => {
    const { store, row } = harness({
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
    } as Partial<Task>);

    await run(store, { priority: "high" });

    expect(row.status).toBe("awaiting-approval");
    expect(row.awaitingApprovalReason).toBe("plan-review-replan-cap");
  });
});
