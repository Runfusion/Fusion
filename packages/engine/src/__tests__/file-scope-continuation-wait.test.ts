import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
import {
  FILE_SCOPE_CONTINUATION_WAIT_PREFIX,
  releaseFileScopeWaitingContinuations,
  settlePlanningContinuationDispatch,
} from "../runtimes/in-process-runtime.js";
import { planningContinuationDispatchLeaseOwner } from "../agents/planning-execution-liveness.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-17-01:25:
Reimplemented for FN-329 "fix immediate file-scope continuation wake", the prerequisite this
branch's FN-332 cherry-pick also excluded. Covers the park-on-settle / wake-on-release pair that
lets a file-scope-blocked continuation sleep instead of busy-polling.

FNXC:PlanningContinuationDispatch 2026-10-09-14:19 (RUFU-330):
The settlement and release both fence on the EXACT lease owner and both re-read the row they wrote
(`transitioned.state` / `transitioned.leaseOwner`), so a fake that ignores `expectedLeaseOwner` and
answers with a row that has no `leaseOwner` field makes every honest call look like a CAS loss
(`leaseOwner: undefined !== null`) and the whole seam silently degrades to `"unchanged"`. The item
fake below therefore owns mutable rows, enforces `expectedState` / `expectedLeaseOwner` exactly like
`transitionWorkflowWorkItem` in `@fusion/core`, and returns the post-transition row truthfully —
mirroring `workflow-file-scope-continuation-wake.test.ts`. Tests pass the same lease owner the real
caller derives (`planningContinuationDispatchLeaseOwner`).
*/

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, column: "in-progress", description: id, dependencies: [],
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

/** A work item claimed for planning dispatch, i.e. the state settlement starts from. */
function runningItem(id: string): WorkflowWorkItem {
  return item(id, {
    state: "running",
    leaseOwner: planningContinuationDispatchLeaseOwner({ id, attempt: 0 }),
    blockedReason: null,
  });
}

function item(id: string, patch: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id,
    kind: "task",
    state: "runnable",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryAfter: null,
    lastError: null,
    blockedReason: null,
    ...patch,
  } as unknown as WorkflowWorkItem;
}

/*
CAS-faithful `transitionWorkflowWorkItem` over a row map: a fence mismatch returns the untouched
existing row (an ordinary CAS loss, not a throw), and a passing write applies the patch and answers
with the stored row so the caller's truthfulness re-read sees what the store really holds.
*/
function createItemStore(items: WorkflowWorkItem[]) {
  const rows = new Map(items.map((row) => [row.id, row]));
  const transitionWorkflowWorkItem = vi.fn(async (
    id: string,
    state: WorkflowWorkItem["state"],
    patch: Record<string, unknown> = {},
  ) => {
    const existing = rows.get(id);
    if (!existing) return null;
    const stateFence = patch.expectedState === undefined || existing.state === patch.expectedState;
    const ownerFence = patch.expectedLeaseOwner === undefined
      || existing.leaseOwner === patch.expectedLeaseOwner;
    if (!stateFence || !ownerFence) return existing;
    const { expectedState: _state, expectedLeaseOwner: _owner, ...updates } = patch;
    const next = { ...existing, ...updates, state } as WorkflowWorkItem;
    rows.set(id, next);
    return next;
  });
  return { rows, transitionWorkflowWorkItem };
}

describe("settlePlanningContinuationDispatch", () => {
  it("parks the item held with a file-scope reason when the task is still queued behind its overlap blocker", async () => {
    const row = runningItem("item-1");
    const { rows, transitionWorkflowWorkItem } = createItemStore([row]);
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: "queued", overlapBlockedBy: "FN-A" })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({
      store,
      taskId: "FN-WAITING",
      itemId: "item-1",
      leaseOwner: planningContinuationDispatchLeaseOwner(row),
      kick,
    });

    expect(outcome).toBe("waiting");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-1", "held", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: planningContinuationDispatchLeaseOwner(row),
      blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A`,
    }));
    expect(rows.get("item-1")).toMatchObject({
      state: "held",
      leaseOwner: null,
      blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A`,
    });
    expect(kick).not.toHaveBeenCalled();
  });

  it("returns the item to runnable and kicks the drain when the task is no longer queued", async () => {
    const row = runningItem("item-1");
    const { rows, transitionWorkflowWorkItem } = createItemStore([row]);
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: undefined })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({
      store,
      taskId: "FN-WAITING",
      itemId: "item-1",
      leaseOwner: planningContinuationDispatchLeaseOwner(row),
      kick,
    });

    expect(outcome).toBe("runnable");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-1", "runnable", expect.objectContaining({
      expectedState: "running",
      expectedLeaseOwner: planningContinuationDispatchLeaseOwner(row),
      blockedReason: null,
    }));
    expect(rows.get("item-1")).toMatchObject({ state: "runnable", leaseOwner: null, blockedReason: null });
    expect(kick).toHaveBeenCalledOnce();
  });

  /*
  FNXC:PlanningContinuationDispatch 2026-10-09-14:19 (RUFU-330):
  The lease-owner fence is the reason settlement cannot clobber a successor that already claimed the
  row; a stale callback must leave the durable row alone rather than park or wake it.
  */
  it("leaves the row alone when a successor has already claimed the dispatch lease", async () => {
    const successor = item("item-1", {
      state: "running",
      attempt: 1,
      leaseOwner: planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 1 }),
    });
    const { rows, transitionWorkflowWorkItem } = createItemStore([successor]);
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: "queued", overlapBlockedBy: "FN-A" })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({
      store,
      taskId: "FN-WAITING",
      itemId: "item-1",
      leaseOwner: planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 0 }),
      kick,
    });

    expect(outcome).toBe("unchanged");
    expect(rows.get("item-1")).toMatchObject({
      state: "running",
      attempt: 1,
      leaseOwner: planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 1 }),
      blockedReason: null,
    });
    expect(kick).not.toHaveBeenCalled();
  });

  it("is a no-op when the store cannot transition work items or the task is deleted", async () => {
    expect(await settlePlanningContinuationDispatch({
      store: {} as TaskStore,
      taskId: "FN-1",
      itemId: "item-1",
      leaseOwner: planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 0 }),
    })).toBe("unchanged");
    const store = {
      getTask: vi.fn(async () => task("FN-1", { deletedAt: "2026-09-01T00:00:00.000Z" } as Partial<Task>)),
      transitionWorkflowWorkItem: vi.fn(),
    } as unknown as TaskStore;
    expect(await settlePlanningContinuationDispatch({
      store,
      taskId: "FN-1",
      itemId: "item-1",
      leaseOwner: planningContinuationDispatchLeaseOwner({ id: "item-1", attempt: 0 }),
    })).toBe("unchanged");
    expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });
});

describe("releaseFileScopeWaitingContinuations", () => {
  it("wakes only held items whose blockedReason names the cleared blocker, on a task whose marker actually cleared", async () => {
    const items: WorkflowWorkItem[] = [
      item("item-match", { state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` }),
      item("item-other-blocker", { state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-B` }),
      item("item-not-held", { state: "runnable", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` }),
    ];
    const { rows, transitionWorkflowWorkItem } = createItemStore(items);
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: undefined })),
      listWorkflowWorkItemsForTask: vi.fn(async () => items),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual(["item-match"]);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-match", "runnable", expect.objectContaining({
      expectedState: "held",
      expectedLeaseOwner: null,
      blockedReason: null,
    }));
    expect(rows.get("item-match")).toMatchObject({ state: "runnable", leaseOwner: null, blockedReason: null });
    expect(rows.get("item-other-blocker")).toMatchObject({
      state: "held",
      blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-B`,
    });
  });

  /*
  FNXC:PlanningContinuationDispatch 2026-10-09-15:01 (RUFU-330):
  A `held` row carrying a live lease owner is not a sleep — some lane still owns it, and the release
  fences on `expectedLeaseOwner: null` precisely so it cannot steal that ownership. The candidate
  filter must refuse before the write, so the row keeps both its lease and its wait reason.
  */
  it("refuses to wake a held item that a live lease still owns", async () => {
    const items: WorkflowWorkItem[] = [
      item("item-leased", {
        state: "held",
        leaseOwner: "claim:item-leased",
        leaseExpiresAt: "2026-09-01T00:05:00.000Z",
        blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A`,
      }),
    ];
    const { rows, transitionWorkflowWorkItem } = createItemStore(items);
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: undefined })),
      listWorkflowWorkItemsForTask: vi.fn(async () => items),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual([]);
    expect(store.listWorkflowWorkItemsForTask).toHaveBeenCalledWith("FN-WAITING", { kinds: ["task"] });
    expect(transitionWorkflowWorkItem).not.toHaveBeenCalled();
    expect(rows.get("item-leased")).toMatchObject({
      state: "held",
      leaseOwner: "claim:item-leased",
      blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A`,
    });
  });

  it("refuses to release while the task's overlap blocker marker is still set", async () => {
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: "FN-A" })),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      transitionWorkflowWorkItem: vi.fn(),
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual([]);
    expect(store.listWorkflowWorkItemsForTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:PlanningContinuationDispatch 2026-10-09-14:19 (RUFU-330):
  Settlement also parks a `dependency:` wait when the card has a dependency wedge and no overlap edge,
  so a release must not wake that sleep while the dependency edge is still on the row — the file-scope
  clear did not remove what the item is actually waiting for.
  */
  it("refuses to release while the task still carries a dependency wedge", async () => {
    const items: WorkflowWorkItem[] = [
      item("item-dependency-wait", { state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` }),
    ];
    const { rows, transitionWorkflowWorkItem } = createItemStore(items);
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", {
        status: "queued",
        overlapBlockedBy: undefined,
        blockedBy: "FN-DEP",
      })),
      listWorkflowWorkItemsForTask: vi.fn(async () => items),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual([]);
    expect(store.listWorkflowWorkItemsForTask).not.toHaveBeenCalled();
    expect(rows.get("item-dependency-wait")).toMatchObject({ state: "held" });
  });
});
