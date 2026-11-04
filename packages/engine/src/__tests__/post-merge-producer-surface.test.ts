/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
The engine half of the predicate, pinned against injected git shapes. The point of injecting the runner is
not convenience: the four outcomes that matter (exit 0, a clean exit 1, exit 128, and a timeout/kill) are
indistinguishable to a fake that returns canned strings, and the difference between "the ref is gone" and
"we could not ask git" is the whole safety margin of this rule. `classifyBranchProbeError` is RUFU-396's
tri-state classifier and this suite reuses it rather than re-deriving the mapping.

Symptom Verification rows (a)-(h) and (m) live here, one row per test, plus the producerCanRun arms whose
job is to keep the rule off any card that still has a claimant.
*/
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type Task, type WorkflowWorkItem } from "@fusion/core";
import {
  resolvePostMergeProducerSurface,
  type GitProbeRunner,
  type PostMergeProducerSurfaceStore,
} from "../merge/post-merge-producer-surface.js";

function gitExit(code: number, opts: { killed?: boolean; signal?: string | null } = {}): Error {
  const err = new Error(`git exited with ${code}`) as Error & { code?: number; killed?: boolean; signal?: string | null };
  err.code = code;
  err.killed = opts.killed ?? false;
  err.signal = opts.signal ?? null;
  return err;
}

/** Routes `show-ref` and `merge-base` independently so each surface gets its own honest exit code. */
function probeRunner(shape: {
  showRef?: () => Promise<string>;
  mergeBase?: () => Promise<string>;
}): GitProbeRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === "show-ref") return shape.showRef ? shape.showRef() : "";
    if (args[0] === "merge-base") return shape.mergeBase ? shape.mergeBase() : "";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  });
}

function workItem(overrides: Partial<WorkflowWorkItem>): WorkflowWorkItem {
  return {
    id: "wi-1",
    runId: "run-1",
    taskId: "RUFU-450",
    nodeId: "post-merge-verification",
    kind: "task",
    state: "runnable",
    leaseExpiresAt: null,
    updatedAt: "2026-11-02T11:59:00.000Z",
    ...overrides,
  } as WorkflowWorkItem;
}

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function storeFor(input: {
  items?: WorkflowWorkItem[] | undefined;
  rootDir?: string | null;
  settings?: Settings;
  itemsThrow?: boolean;
}): PostMergeProducerSurfaceStore {
  const rootDir = input.rootDir === undefined ? "/repo" : input.rootDir;
  return {
    getRootDir: () => rootDir as string,
    getSettings: async () => input.settings ?? ({ ...DEFAULT_SETTINGS } as Settings),
    listWorkflowWorkItemsForTask: input.items === undefined && !input.itemsThrow
      ? undefined
      : async () => {
        if (input.itemsThrow) throw new Error("store unavailable");
        return input.items ?? [];
      },
  } as unknown as PostMergeProducerSurfaceStore;
}

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-450",
    branch: "fusion/rufu-450",
    mergeDetails: { mergeConfirmed: true },
    ...overrides,
  } as Task;
}

const landedItems = [workItem({ state: "failed" })];

describe("resolvePostMergeProducerSurface — the git verdict", () => {
  it("reports ref-absent when show-ref answers a clean exit 1 (rows a/b: VLLM-081's no-live-branch)", async () => {
    const runGit = probeRunner({ showRef: async () => { throw gitExit(1); } });
    const observation = await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems }), card(), { runGit, now: () => NOW },
    );
    expect(observation).toEqual({ surface: "ref-absent", mergeConfirmed: true, producerCanRun: false });
    // An absent ref makes ancestry unaskable: only one probe may run.
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runGit).mock.calls[0]?.[0]).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/fusion/rufu-450"]);
  });

  it("reports ref-merged when the ref exists and the target already contains it (row c: RUFU-326's 0/0)", async () => {
    const runGit = probeRunner({ mergeBase: async () => "" });
    const observation = await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems }), card(), { runGit, now: () => NOW },
    );
    expect(observation?.surface).toBe("ref-merged");
    expect(runGit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runGit).mock.calls[1]?.[0]).toEqual(["merge-base", "--is-ancestor", "fusion/rufu-450", "main"]);
  });

  it("reports ref-divergent when git honestly answers 'not an ancestor' (row e)", async () => {
    const runGit = probeRunner({ mergeBase: async () => { throw gitExit(1); } });
    const observation = await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems }), card(), { runGit, now: () => NOW },
    );
    expect(observation?.surface).toBe("ref-divergent");
  });

  it("reports unknown for an exit 128, a killed probe, and a throwing probe (row f) — never absence", async () => {
    const hostileProbes: Array<[string, () => Promise<string>]> = [
      ["exit 128 (not a repository / bad ref)", () => { throw gitExit(128); }],
      ["timeout (killed)", () => { throw gitExit(1, { killed: true, signal: "SIGTERM" }); }],
      ["signal without a code", () => { throw gitExit(0, { signal: "SIGKILL" }); }],
    ];
    for (const [label, probe] of hostileProbes) {
      const observation = await resolvePostMergeProducerSurface(
        storeFor({ items: landedItems }), card(), { runGit: probeRunner({ showRef: probe }), now: () => NOW },
      );
      expect(observation?.surface, label).toBe("unknown");
    }
  });

  it("merges against the card's recorded merge target when the merge recorded one", async () => {
    const runGit = probeRunner({});
    await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems }),
      card({ mergeDetails: { mergeConfirmed: true, mergeTargetBranch: "release/1.0" } }),
      { runGit, now: () => NOW },
    );
    expect(vi.mocked(runGit).mock.calls[1]?.[0]).toEqual(["merge-base", "--is-ancestor", "fusion/rufu-450", "release/1.0"]);
  });

  it("derives the ref from the task id when the pointer was cleared, and never consults worktree (row b)", async () => {
    const runGit = probeRunner({ showRef: async () => { throw gitExit(1); } });
    // `worktree: null` with a stale non-null `branch` is the shape post-landing cleanup actually leaves.
    const observation = await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems }),
      card({ branch: null, worktree: null }),
      { runGit, now: () => NOW },
    );
    expect(vi.mocked(runGit).mock.calls[0]?.[0]).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/fusion/rufu-450"]);
    expect(observation?.surface).toBe("ref-absent");
  });

  it("produces no verdict at all when the project root or the settings read is unavailable", async () => {
    const runGit = probeRunner({});
    expect(await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems, rootDir: "" }), card(), { runGit, now: () => NOW },
    )).toBeUndefined();
    expect(await resolvePostMergeProducerSurface(
      storeFor({ items: landedItems }), card(), {
        runGit,
        now: () => NOW,
        getSettings: async () => { throw new Error("settings unavailable"); },
      },
    )).toBeUndefined();
    expect(runGit).not.toHaveBeenCalled();
  });
});

describe("resolvePostMergeProducerSurface — producerCanRun (read-only, never a repair)", () => {
  async function canRun(items: WorkflowWorkItem[] | undefined, extra: { itemsThrow?: boolean; isExecutionLive?: (id: string) => boolean } = {}) {
    const observation = await resolvePostMergeProducerSurface(
      storeFor({ items, itemsThrow: extra.itemsThrow }),
      card(),
      { runGit: probeRunner({ showRef: async () => { throw gitExit(1); } }), now: () => NOW, isExecutionLive: extra.isExecutionLive },
    );
    return observation?.producerCanRun;
  }

  it("says a scheduler-claimable continuation can still run (row m: the normal post-merge hop)", async () => {
    expect(await canRun([workItem({ state: "runnable" })])).toBe(true);
    expect(await canRun([workItem({ state: "retrying" })])).toBe(true);
  });

  it("says a held continuation can still run: a manual lane's owner is expected to press Run", async () => {
    expect(await canRun([workItem({ state: "held" })])).toBe(true);
  });

  it("says a running continuation with an unexpired lease is live", async () => {
    expect(await canRun([workItem({ state: "running", leaseExpiresAt: new Date(NOW + 60_000).toISOString() })])).toBe(true);
  });

  it("says RUFU-610's leaseless running row past the stale floor advances nothing (row d)", async () => {
    const stale = new Date(NOW - 3 * 60 * 60_000).toISOString();
    expect(await canRun([workItem({ state: "running", leaseExpiresAt: null, updatedAt: stale })])).toBe(false);
    expect(await canRun([workItem({ state: "running", leaseExpiresAt: new Date(NOW - 1_000).toISOString(), updatedAt: stale })])).toBe(false);
  });

  it("keeps a running row inside the stale floor advanceable — a real reviewer step is not yet abandoned", async () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    expect(await canRun([workItem({ state: "running", leaseExpiresAt: null, updatedAt: fresh })])).toBe(true);
  });

  it("treats a durable fresh checkout lease and an in-process live session as live producers", async () => {
    // `hasFreshCheckoutLease` measures against the wall clock (FN-9442's rule), so the fixture is fresh now.
    const leased = card({ checkoutRunId: "run-7", checkoutLeaseRenewedAt: new Date(Date.now() - 1_000).toISOString() });
    const withLease = await resolvePostMergeProducerSurface(
      storeFor({ items: [workItem({ state: "failed" })] }), leased,
      { runGit: probeRunner({ showRef: async () => { throw gitExit(1); } }), now: () => NOW },
    );
    expect(withLease?.producerCanRun).toBe(true);

    expect(await canRun([workItem({ state: "failed" })], { isExecutionLive: () => true })).toBe(true);
  });

  it("produces no verdict when the work-item read is missing or misbehaves — an unmeasurable leg is not a refusal", async () => {
    expect(await canRun(undefined)).toBeUndefined();
    expect(await canRun([], { itemsThrow: true })).toBeUndefined();
  });

  it("counts no other kind of work item as this card's producer", async () => {
    expect(await canRun([workItem({ kind: "agent" as never, state: "runnable" })])).toBe(false);
  });

  it("never asks the re-seed seam: the probe issues git and store reads only, and writes nothing", async () => {
    const store = storeFor({ items: landedItems }) as Record<string, unknown>;
    const updateTask = vi.fn();
    store.updateTask = updateTask;
    const observation = await resolvePostMergeProducerSurface(
      store as unknown as PostMergeProducerSurfaceStore, card(),
      { runGit: probeRunner({ showRef: async () => { throw gitExit(1); } }), now: () => NOW },
    );
    expect(observation?.producerCanRun).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
