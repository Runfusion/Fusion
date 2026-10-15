import { describe, it, expect, vi } from "vitest";
import {
  ISOLATION_BLOCKER_READ_TIMEOUT_MS,
  ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS,
  classifyIsolationBlockers,
  resolveIsolationBlockerAnswer,
  resolveIsolationTransitionBlockers,
  withBoundedRead,
  type IsolationBlockerRow,
} from "../project/isolation-transition-blockers.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

/*
FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
The durable blocker read exists to keep an operator from being locked out of a setting while ALSO
never green-lighting a restart that destroys live work. Both failure directions are pinned here:
a hang/rejection must degrade to `null` (refuse as before) and never to `[]` (proceed), and one hung
card must never cost more than one bounded batch.
*/

const row = (over: Partial<IsolationBlockerRow> & { id: string }): IsolationBlockerRow => ({
  column: "in-progress",
  status: "failed",
  ...over,
});

const storeReturning = (rows: IsolationBlockerRow[]) => {
  const listTasks = vi.fn(async () => rows);
  return { store: { listTasks }, listTasks };
};

describe("isolation-transition blocker budgets", () => {
  it("pins the two declared budget constants exactly, inner strictly below outer", () => {
    // The spec names these two values and this task adds no other timeout. If either moves, every
    // timing assertion below has to be re-read, so this pin is the contract, not a nicety.
    expect(ISOLATION_BLOCKER_READ_TIMEOUT_MS).toBe(500);
    expect(ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS).toBe(300);
    expect(ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS).toBeLessThan(ISOLATION_BLOCKER_READ_TIMEOUT_MS);
  });
});

describe("withBoundedRead", () => {
  it("passes through a value that settles inside the budget", async () => {
    await expect(withBoundedRead(async () => "answered", 50)).resolves.toBe("answered");
  });

  it("resolves null when the work never settles, and keeps the event loop free", async () => {
    const hanging = new Promise<string>(() => {});
    const started = Date.now();
    const result = await withBoundedRead(() => hanging, 20);
    const elapsed = Date.now() - started;
    expect(result).toBeNull();
    // The bound is enforced, not decorative: the read is a handful of milliseconds, not its own await.
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves null for a rejecting read instead of throwing at the guard", async () => {
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", collect);
    await expect(withBoundedRead(async () => {
      throw new Error("store exploded");
    }, 50)).resolves.toBeNull();
    // Give any stray microtask a chance to surface before declaring the read clean.
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", collect);
    expect(unhandled).toEqual([]);
  });

  it("issues no I/O at all when the budget is already spent", async () => {
    const start = vi.fn(async () => "should not run");
    await expect(withBoundedRead(start, 0)).resolves.toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("drops a late answer without rejecting or resurrecting the decision", async () => {
    let release: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      release = resolve;
    });
    await expect(withBoundedRead(() => work, 5)).resolves.toBeNull();
    release("too late");
    await expect(work).resolves.toBe("too late");
  });
});

describe("classifyIsolationBlockers", () => {
  it("releases only a failed card sitting in the terminal-park lane with no live surface", () => {
    const { blockers, contradictedInMemory, unknownIds } = classifyIsolationBlockers({
      holderIds: ["SANE-435", "SANE-453"],
      rows: [
        row({ id: "SANE-435", column: "in-progress", status: "failed" }),
        row({ id: "SANE-453", column: "in-progress", status: "failed" }),
      ],
      isLive: () => false,
    });
    expect(blockers).toEqual([]);
    expect(contradictedInMemory).toEqual([]);
    expect(unknownIds).toEqual([]);
  });

  it("keeps a failed card blocking in every lane except the terminal-park lane", () => {
    for (const column of ["todo", "in-review", "done"] as const) {
      const { blockers } = classifyIsolationBlockers({
        holderIds: ["RUFU-1"],
        rows: [row({ id: "RUFU-1", column, status: "failed" })],
        isLive: () => false,
      });
      expect(blockers, `failed in ${column}`).toEqual(["RUFU-1"]);
    }
  });

  it("keeps a non-failed row blocking whatever its lane, including an idle-looking in-progress card", () => {
    const { blockers } = classifyIsolationBlockers({
      holderIds: ["RUFU-2"],
      rows: [row({ id: "RUFU-2", column: "in-progress", status: "queued" })],
      isLive: () => false,
    });
    expect(blockers).toEqual(["RUFU-2"]);
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-03:20 (RUFU-328):
  The invariant the whole task turns on, pinned at the purest seam: a durable `failed` row in the
  terminal-park lane exempts its card EVEN WHEN the in-memory liveness signal is still true for it. The
  leaked binding is that still-true signal — if a true predicate could re-block it, the veto could never
  fire, because the guard only consults durable state when the in-memory count already says busy. The
  disagreement is not swallowed: it is returned as drift evidence for the caller to log.
  */
  it("exempts a durable terminal park whose in-memory liveness signal is still true, and records the contradiction", () => {
    const { blockers, contradictedInMemory } = classifyIsolationBlockers({
      holderIds: ["RUFU-3"],
      rows: [row({ id: "RUFU-3", column: "in-progress", status: "failed" })],
      isLive: () => true,
    });
    expect(blockers).toEqual([]);
    expect(contradictedInMemory).toEqual(["RUFU-3"]);
  });

  it("treats a card the read never described as unknown-and-blocking, never as free", () => {
    const { blockers, unknownIds } = classifyIsolationBlockers({
      holderIds: ["RUFU-4"],
      rows: [row({ id: "OTHER-1" })],
      isLive: () => false,
    });
    expect(blockers).toEqual(["RUFU-4"]);
    expect(unknownIds).toEqual(["RUFU-4"]);
  });

  it("releases nothing when a read returns no rows at all", () => {
    // A read that returns nothing is a successful read that describes nobody: every held card is
    // unknown, so the answer is "these cards block", not the all-clear.
    const { blockers } = classifyIsolationBlockers({
      holderIds: ["RUFU-5", "RUFU-6"],
      rows: [],
      isLive: () => false,
    });
    expect(blockers).toEqual(["RUFU-5", "RUFU-6"]);
  });

  it("counts a workspace card holding several sub-repos as one blocker", () => {
    // Holder ids are deduped per card upstream, so the same id arrives once even for N sub-repo
    // paths. The durable row says the card is still running, so it blocks exactly once.
    const { blockers } = classifyIsolationBlockers({
      holderIds: ["RUFU-7"],
      rows: [row({ id: "RUFU-7", status: "executing" })],
      isLive: () => true,
    });
    expect(blockers).toEqual(["RUFU-7"]);
  });
});

describe("resolveIsolationTransitionBlockers", () => {
  it("issues exactly ONE batched board read, board-shaped, for several held cards", async () => {
    const { store, listTasks } = storeReturning([row({ id: "A" }), row({ id: "B" })]);
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A", "B"],
      store,
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listTasks.mock.calls[0][0]).toMatchObject({ derive: false, excludeLog: true });
    expect(listTasks.mock.calls[0][0].columns).toContain("in-progress");
    expect(decision.blockers).toEqual([]);
    expect(decision.reason).toBe("declared-clear");
  });

  it("names the blocking cards when durable state still counts them", async () => {
    const { store } = storeReturning([
      row({ id: "A", column: "in-progress", status: "failed" }),
      row({ id: "B", column: "in-progress", status: "executing" }),
    ]);
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A", "B"],
      store,
      isLive: (id) => id === "B",
      entryAtMs: Date.now(),
    });
    expect(decision.blockers).toEqual(["B"]);
    expect(decision.reason).toBe("declared-blocked");
  });

  it("answers store-unavailable without issuing a read when there is no durable store", async () => {
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: null,
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    expect(decision.blockers).toBeNull();
    expect(decision.reason).toBe("store-unavailable");
  });

  it("answers read-timed-out within the inner budget when the store hangs", async () => {
    const started = Date.now();
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: { listTasks: () => new Promise(() => {}) },
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    const elapsed = Date.now() - started;
    expect(decision.blockers).toBeNull();
    expect(decision.reason).toBe("read-timed-out");
    // The hung read must not consume the whole transition attempt.
    expect(elapsed).toBeLessThan(ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS + 150);
  });

  it("answers read-rejected when the store throws, distinguishing it from a timeout", async () => {
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: {
        listTasks: async () => {
          throw new Error("connection reset");
        },
      },
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    expect(decision.blockers).toBeNull();
    expect(decision.reason).toBe("read-rejected");
  });

  it("issues no read when the outer budget was already spent before it was asked", async () => {
    const listTasks = vi.fn(async () => [] as IsolationBlockerRow[]);
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: { listTasks },
      isLive: () => false,
      // The transition entered one full outer budget ago (the settings fetch ate it).
      entryAtMs: Date.now() - ISOLATION_BLOCKER_READ_TIMEOUT_MS - 1,
    });
    expect(listTasks).not.toHaveBeenCalled();
    expect(decision.blockers).toBeNull();
    expect(decision.reason).toBe("budget-exhausted");
  });

  it("charges the drain budget for the time the decision consumed", async () => {
    const clock = { t: 1_000 };
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: {
        listTasks: async () => {
          clock.t += 120;
          return [row({ id: "A" })];
        },
      },
      isLive: () => false,
      entryAtMs: clock.t,
      configuredDrainMs: 2_000,
      now: () => clock.t,
    });
    expect(decision.drainMs).toBe(1_880);
  });

  it("hands back a zero drain budget when the runtime declared a zero drain", async () => {
    const clock = { t: 5_000 };
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: {
        listTasks: async () => {
          clock.t += 50;
          return [row({ id: "A" })];
        },
      },
      isLive: () => false,
      entryAtMs: clock.t,
      configuredDrainMs: 0,
      now: () => clock.t,
    });
    expect(decision.drainMs).toBe(0);
  });

  it("carries a drain number even on a cannot-answer decision", async () => {
    const decision = await resolveIsolationTransitionBlockers({
      holderIds: ["A"],
      store: null,
      isLive: () => false,
      entryAtMs: Date.now(),
      configuredDrainMs: 2_000,
    });
    expect(decision.blockers).toBeNull();
    expect(decision.drainMs).toBeLessThanOrEqual(2_000);
    expect(decision.drainMs).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveIsolationBlockerAnswer", () => {
  it("never throws and answers null when the resolution itself overruns its budget", async () => {
    const answer = await resolveIsolationBlockerAnswer({
      holderIds: ["A"],
      store: { listTasks: () => new Promise(() => {}) },
      isLive: () => false,
      entryAtMs: Date.now(),
      outerBudgetMs: 20,
      storeBudgetMs: 5_000,
    });
    expect(answer.taskIds).toBeNull();
    expect(answer.reason).toBeDefined();
  });

  it("preserves the three-way answer shape on the transport", async () => {
    const clear = await resolveIsolationBlockerAnswer({
      holderIds: ["A"],
      store: { listTasks: async () => [row({ id: "A" })] },
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    expect(clear.taskIds).toEqual([]);

    const blocked = await resolveIsolationBlockerAnswer({
      holderIds: ["A"],
      store: { listTasks: async () => [row({ id: "A", column: "todo" })] },
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    expect(blocked.taskIds).toEqual(["A"]);

    const unknown = await resolveIsolationBlockerAnswer({
      holderIds: ["A"],
      store: null,
      isLive: () => false,
      entryAtMs: Date.now(),
    });
    expect(unknown.taskIds).toBeNull();
  });
});

describe("InProcessRuntime.getInFlightBlockers", () => {
  /**
   * The method touches only the executor holder surface, the runtime's store, and its project id, so
   * the durability-parity answer is exercised at that seam instead of booting a whole runtime.
   */
  const callRuntime = (fake: {
    holderIds?: string[];
    isLive?: (taskId: string) => boolean;
    settings?: { runtimeStopDrainMs?: number };
    rows?: IsolationBlockerRow[];
    listTasks?: (options: unknown) => Promise<IsolationBlockerRow[]>;
  }) => {
    const listTasks =
      fake.listTasks ?? vi.fn(async () => fake.rows ?? ([] as IsolationBlockerRow[]));
    const thisArg = {
      config: { projectId: "proj-1" },
      executor: {
        listWorktreeHolders: () => (fake.holderIds ?? []).map((taskId) => ({ taskId, worktreePath: `/wt/${taskId}` })),
        isTaskLiveForOverseerRetry: fake.isLive ?? (() => false),
      },
      taskStore: {
        listTasks,
        getSettings: async () => fake.settings ?? {},
      },
    };
    const method = InProcessRuntime.prototype.getInFlightBlockers!;
    const answer = method.call(thisArg as unknown as InProcessRuntime, { budgetMs: 400 });
    return { answer, listTasks };
  };

  it("answers the all-clear for held cards whose durable rows are terminal parks", async () => {
    const { answer } = callRuntime({
      holderIds: ["SANE-435", "SANE-453"],
      rows: [row({ id: "SANE-435" }), row({ id: "SANE-453" })],
    });
    await expect(answer).resolves.toMatchObject({ taskIds: [] });
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-03:20 (RUFU-328):
  The same invariant one seam up, where the runtime's own liveness predicate is the leak: the card is
  still live on an execution surface, its durable row is the terminal park, and the answer is the
  all-clear. `getMetrics().inFlightTasks` still reads 1 for this exact card — the two signals are
  deliberately allowed to disagree, the metric for "what is running" and this answer for "what would a
  transition destroy".
  */
  it("answers the all-clear for a card whose durable row is a terminal park while the runtime still calls it live", async () => {
    const { answer } = callRuntime({
      holderIds: ["SANE-499"],
      rows: [row({ id: "SANE-499", column: "in-progress", status: "failed" })],
      isLive: () => true,
    });
    const resolved = await answer;
    expect(resolved.taskIds).toEqual([]);
    expect(resolved.contradictedInMemory).toEqual(["SANE-499"]);
  });

  it("names a card the durable read still counts, whatever the in-memory signal says", async () => {
    const { answer } = callRuntime({
      holderIds: ["SANE-500"],
      rows: [row({ id: "SANE-500", column: "in-progress", status: "executing" })],
      isLive: () => false,
    });
    await expect(answer).resolves.toMatchObject({ taskIds: ["SANE-500"] });
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-03:30 (RUFU-328):
  The enumeration the runtime prefers: the executor's own held-id listing. Pinning it separately from the
  `listWorktreeHolders` shape above is the point — the veto must keep working when that older facade is
  absent, and must NOT pre-filter by liveness at enumeration time, or a card whose in-memory signal is a
  stale negative is never even put to the durable row.
  */
  it("enumerates holders through the executor's id facade and still asks the durable row", async () => {
    const listTasks = vi.fn(async () => [row({ id: "SANE-501", status: "executing" }), row({ id: "SANE-502" })]);
    const thisArg = {
      config: { projectId: "proj-1" },
      executor: {
        // The real executor facade, and deliberately no `listWorktreeHolders` to fall back on.
        listWorktreeHolderIds: () => ["SANE-501", "SANE-502", "SANE-502"],
        isTaskLiveForOverseerRetry: () => false,
      },
      taskStore: { listTasks, getSettings: async () => ({}) },
    };
    const method = InProcessRuntime.prototype.getInFlightBlockers!;
    const answer = await method.call(thisArg as unknown as InProcessRuntime, { budgetMs: 400 });

    // The not-live `executing` row still blocks; the terminal park is exempt; each card is named once.
    expect(answer.taskIds).toEqual(["SANE-501"]);
    expect(listTasks).toHaveBeenCalledTimes(1);
    const readShape = listTasks.mock.calls[0][0] as Record<string, unknown>;
    expect(readShape).toMatchObject({ derive: false, excludeLog: true });
    expect(readShape.columns).toContain("in-progress");
  });

  it("degrades to null when the runtime's store hangs", async () => {
    const { answer } = callRuntime({
      holderIds: ["A"],
      listTasks: () => new Promise<IsolationBlockerRow[]>(() => {}),
    });
    await expect(answer).resolves.toMatchObject({ taskIds: null });
  });

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-03:20 (RUFU-328):
  An executor double with no liveness facade (the shape `engine-stop-aborts-execution.test.ts` builds)
  still counts as live — but after the invariant correction that conservative default decides only
  whether a disagreement gets RECORDED, never whether the card blocks: the durable row decides that.
  So the same double yields a blocker for a row the board still counts, and an exempted card plus drift
  evidence for a terminal park.
  */
  it("treats an executor that cannot answer liveness as busy for drift purposes, while the row still decides", async () => {
    const call = async (rows: IsolationBlockerRow[]) => {
      const thisArg = {
        config: { projectId: "proj-1" },
        // A double with the ownership map but no liveness facade — the shape
        // `engine-stop-aborts-execution.test.ts` builds.
        executor: { activeWorktrees: new Map([["A", new Set(["/wt/A"])]]), activeTasks: new Map() },
        taskStore: { listTasks: async () => rows, getSettings: async () => ({}) },
      };
      const method = InProcessRuntime.prototype.getInFlightBlockers!;
      return method.call(thisArg as unknown as InProcessRuntime, { budgetMs: 400 });
    };

    // A row the board still counts: busy, with nothing to contradict.
    const running = await call([row({ id: "A", status: "executing" })]);
    expect(running.taskIds).toEqual(["A"]);
    expect(running.contradictedInMemory ?? []).toEqual([]);

    // A terminal park: exempt, and the unknown liveness is reported as the disagreement it is.
    const parked = await call([row({ id: "A" })]);
    expect(parked.taskIds).toEqual([]);
    expect(parked.contradictedInMemory).toEqual(["A"]);
  });

  it("carries the configured drain budget down to the caller's stop()", async () => {
    const { answer } = callRuntime({
      holderIds: ["A"],
      rows: [row({ id: "A" })],
      settings: { runtimeStopDrainMs: 1_234 },
    });
    const resolved = await answer;
    expect(resolved.drainMs).toBeLessThanOrEqual(1_234);
    expect(resolved.drainMs).toBeGreaterThan(0);
  });

  it("hands back a zero drain when settings declare a zero drain", async () => {
    const { answer } = callRuntime({
      holderIds: ["A"],
      rows: [row({ id: "A" })],
      settings: { runtimeStopDrainMs: 0 },
    });
    const resolved = await answer;
    expect(resolved.drainMs).toBe(0);
  });

  it("does not issue a board read when the runtime holds nothing", async () => {
    const { answer, listTasks } = callRuntime({ holderIds: [] });
    const resolved = await answer;
    expect(resolved.taskIds).toEqual([]);
    expect(listTasks).not.toHaveBeenCalled();
  });
});
