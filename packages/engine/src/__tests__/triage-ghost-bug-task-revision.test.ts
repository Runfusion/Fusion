/**
 * GhostBug caller regression: the ghost-bug preflight driven THROUGH THE REAL TRIAGE FINALIZER.
 *
 * FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
 * Everything here asserts through production entry points and REAL WRITE RECEIPTS — which writes
 * actually landed on the live row, which production seams ran — rather than a mock declaring a
 * fabricated token authoritative.
 *
 * The store double is production-FAITHFUL by contract, not merely convenient. It models, in one
 * fixture:
 *  - a mutable live row carrying a NON-EMPTY `log` array (so a log-stripped read that clobbers
 *    history fails visibly here),
 *  - `logEntry` advancing the row's `updatedAt` (both production branches do —
 *    `packages/core/src/task-store/audit-ops.ts` ~:353 / ~:455),
 *  - `logEntry` THROWING the read-only refusal once the live row sits in an archived lane (both
 *    production branches do — ~:326-336 / ~:438-445),
 *  - `updateTaskUnlocked` honouring `shouldPersist` and the `TaskAtomicPersistFence` conditions,
 *    writing nothing and refusing when the fence does not match,
 *  - `moveTaskIf` re-checking the fenced decision's expected record at COMMIT time (the core
 *    transaction seam), applying decision + move together only when everything passes,
 *  - `recordActivity` writing a SEPARATE activity entity that never mutates the task row.
 * A fixture that omits any of these hides a real failure mode and is the regression this file exists
 * to prevent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Settings, Task, TaskLogEntry, TaskStore } from "@fusion/core";
import { TriageProcessor, createGhostBugProbeExec } from "../triage.js";
import { GHOST_BUG_ARCHIVE_REASON, type ProbeExec } from "../triage-domain/triage-preflight.js";

const execFileAsync = promisify(execFile);
const ARCHIVED = "archived";
const HOLDING = "todo";

const REVISION_SHA = "a".repeat(40);
const MAIN_SHA = "b".repeat(40);
const MOVED_SHA = "c".repeat(40);

/** Bug-fix-shaped spec naming a construct the probes look for. */
function specFor(taskId: string, construct = "ghost_target_fn"): string {
  return `# Task: ${taskId} - fix: typecheck error in ghost_target_fn

## Original Description

Regression: \`ghost_target_fn\` is broken.

## Steps

### Step 0: Implement

- [ ] Do the work
`;
}

function taskFixture(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const now = "2026-10-11T12:00:00.000Z";
  return {
    id: overrides.id,
    title: overrides.title ?? `${overrides.id} fix: typecheck error`,
    description: overrides.description ?? "Regression: ghost_target_fn is broken. See \`ghost_target_fn\`.",
    priority: "normal",
    column: overrides.column ?? "triage",
    status: overrides.status ?? "planning",
    steps: [],
    currentStep: 0,
    dependencies: [],
    log: overrides.log ?? [{ timestamp: now, action: "Task created" }],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    columnMovedAt: overrides.columnMovedAt ?? now,
    ...overrides,
  } as Task;
}

const NEVER_SETTLES: ProbeExec = () => new Promise<never>(() => undefined);

interface CommitReceipt {
  taskId: string;
  toColumn: string;
  fromColumn: string;
  moved: boolean;
  /** The fenced decision applied in this commit, when one was supplied and passed. */
  decisionAction?: string;
}

interface FixtureOptions {
  task?: Partial<Task> & Pick<Task, "id">;
  /** Injected between the seam's predicate passing and its commit-time re-check. */
  onAfterPredicate?: (harness: StoreHarness) => void | Promise<void>;
  /** Rejects the atomic hold write the way a zero-row SQL compare-and-set does. */
  refuseHoldFence?: boolean;
  rejectPostCommitActivity?: boolean;
  rejectMailbox?: boolean;
}

interface StoreHarness {
  row: Task;
  store: TaskStore;
  commits: CommitReceipt[];
  activities: Array<{ type: string; metadata?: Record<string, unknown> }>;
  auditRows: Array<{ mutationType: string; metadata?: Record<string, unknown> }>;
  mailbox: Array<{ content: string; dedupeKey: string }>;
  /** Every `logEntry` ATTEMPT, including the ones production would reject. */
  logEntryAttempts: string[];
  applyRowChange: (patch: Partial<Task>) => void;
}

/**
 * A live-row store double with the production persistence mechanisms described at the top of the file.
 */
function createStoreHarness(options: FixtureOptions): StoreHarness {
  const row: Task = taskFixture(options.task);
  const commits: CommitReceipt[] = [];
  const activities: StoreHarness["activities"] = [];
  const auditRows: StoreHarness["auditRows"] = [];
  const mailbox: StoreHarness["mailbox"] = [];
  const logEntryAttempts: string[] = [];

  /** Serialized against itself, like the in-process task lock it models. */
  let lockChain: Promise<unknown> = Promise.resolve();
  const withTaskLock = async (_id: string, callback: () => unknown): Promise<any> => {
    const run = () => callback();
    const result = lockChain.then(run, run);
    lockChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const snapshot = (): Task => ({ ...row, log: [...(row.log ?? [])] });
  const bump = () => { row.updatedAt = new Date(Date.parse(row.updatedAt) + 1_000).toISOString(); };

  const harness = {
    row,
    store: null as unknown as TaskStore,
    commits,
    activities,
    auditRows,
    mailbox,
    logEntryAttempts,
    applyRowChange: (patch: Partial<Task>) => { Object.assign(row, patch); bump(); },
  } as unknown as StoreHarness;

  const fenceMatches = (fence: Record<string, unknown> | undefined): boolean => {
    if (!fence) return true;
    if (row.updatedAt !== fence.expectedUpdatedAt) return false;
    if ((row.checkedOutBy ?? null) !== (fence.expectedCheckedOutBy ?? null)) return false;
    if ((row.checkoutNodeId ?? null) !== (fence.expectedCheckoutNodeId ?? null)) return false;
    if ((row.checkoutLeaseEpoch ?? 0) !== (fence.expectedCheckoutLeaseEpoch ?? 0)) return false;
    return true;
  };

  const store: Partial<TaskStore> = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    isBackendMode: vi.fn(() => false),
    getTask: vi.fn(async () => snapshot()),
    getSettings: vi.fn(async (): Promise<Settings> => ({
      maxConcurrent: 2,
      pollIntervalMs: 10_000,
      requirePlanApproval: false,
      autoMerge: true,
    } as Settings)),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => [snapshot()]),
    getTaskDocument: vi.fn(async () => null),
    upsertTaskDocument: vi.fn(async () => undefined),
    parseStepsFromPrompt: vi.fn(async () => [{ label: "Do the work", status: "pending" }]),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    parseDependenciesFromPrompt: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      const { log, ...rest } = patch as { log?: TaskLogEntry[] };
      Object.assign(row, rest);
      if (log) row.log = log;
      bump();
      return snapshot();
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Record<string, unknown> | null) => {
      const patch = await updater(snapshot());
      if (!patch) return snapshot();
      const { log, ...rest } = patch as { log?: TaskLogEntry[] };
      Object.assign(row, rest);
      if (log) row.log = log;
      bump();
      return snapshot();
    }),
    withTaskLock: vi.fn(withTaskLock) as never,
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => unknown) => callback()) as never,
    readTaskForMove: vi.fn(async () => snapshot()),
    updateTaskUnlocked: vi.fn(async (
      _id: string,
      patch: Record<string, unknown>,
      _runContext?: unknown,
      shouldPersist?: () => boolean,
      persistFence?: Record<string, unknown>,
    ) => {
      if (shouldPersist && !shouldPersist()) throw new Error("TaskAtomicPersistGuardRefusedError");
      if (options.refuseHoldFence) throw new Error("TaskAtomicPersistGuardRefusedError");
      if (!fenceMatches(persistFence)) throw new Error("TaskAtomicPersistGuardRefusedError");
      const { log, ...rest } = patch as { log?: TaskLogEntry[] };
      Object.assign(row, rest);
      if (log) row.log = log;
      bump();
      return snapshot();
    }) as never,
    /*
    FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
    PRODUCTION FIDELITY, BOTH BEHAVIOURS IN ONE DOUBLE. An attempt is recorded even when it is about
    to be refused, so a test can prove structurally that the archive path issues ZERO post-commit
    task-log writes rather than merely asserting a count that a suppressed write would also satisfy.
    */
    logEntry: vi.fn(async (_id: string, action: string) => {
      logEntryAttempts.push(action);
      if (row.column === ARCHIVED) {
        throw new Error(`Task ${row.id} is archived and its history is read-only (refused: ${action})`);
      }
      row.log = [...(row.log ?? []), { timestamp: new Date().toISOString(), action }];
      bump();
      return snapshot();
    }) as never,
    recordActivity: vi.fn(async (input: { type: string; metadata?: Record<string, unknown> }) => {
      if (options.rejectPostCommitActivity) throw new Error("activity sink unavailable");
      activities.push(input);
    }) as never,
    recordRunAuditEvent: vi.fn(async (input: { mutationType: string; metadata?: Record<string, unknown> }) => {
      auditRows.push(input);
    }) as never,
    moveTask: vi.fn(async (_id: string, toColumn: string) => {
      row.column = toColumn;
      bump();
      return snapshot();
    }) as never,
    /*
    FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
    Models Step 3's transaction seam: read → predicate → (post-predicate interleave point) →
    commit-time expected-row re-check → decision + transition applied TOGETHER, or neither.
    */
    moveTaskIf: vi.fn(async (
      _id: string,
      toColumn: string,
      predicate: (live: Task) => boolean | Promise<boolean>,
      _options?: unknown,
      fencedDecision?: { entry: { action: string; outcome?: string }; expected: Record<string, unknown> },
    ) => {
      return withTaskLock(_id, async () => {
        const live = snapshot();
        if (!await predicate(live) || live.column === toColumn) {
          commits.push({ taskId: _id, toColumn, fromColumn: live.column, moved: false });
          return { task: live, moved: false };
        }

        await options.onAfterPredicate?.(harness);

        const fresh = snapshot();
        const expected = fencedDecision?.expected;
        const identity = (expected?.identity ?? {}) as Record<string, unknown>;
        const mismatched = fresh.column !== expected?.expectedColumn
          || fresh.updatedAt !== expected?.expectedUpdatedAt
          || (fresh.checkedOutBy ?? null) !== (expected?.expectedCheckedOutBy ?? null)
          || (fresh.checkoutNodeId ?? null) !== (expected?.expectedCheckoutNodeId ?? null)
          || (fresh.checkoutLeaseEpoch ?? 0) !== (expected?.expectedCheckoutLeaseEpoch ?? 0)
          || Object.entries(identity).some(([key, want]) => (fresh as unknown as Record<string, unknown>)[key] !== want);

        if (expected && mismatched) {
          // Neither the decision nor the move persists.
          commits.push({ taskId: _id, toColumn, fromColumn: fresh.column, moved: false });
          return { task: fresh, moved: false };
        }

        // ONE commit: decision entry appended to the FRESH log, then the column transition.
        if (fencedDecision) {
          row.log = [...(fresh.log ?? []), {
            timestamp: new Date().toISOString(),
            action: fencedDecision.entry.action,
            ...(fencedDecision.entry.outcome ? { outcome: fencedDecision.entry.outcome } : {}),
          }];
        }
        row.column = toColumn;
        bump();
        commits.push({
          taskId: _id,
          toColumn,
          fromColumn: fresh.column,
          moved: true,
          ...(fencedDecision ? { decisionAction: fencedDecision.entry.action } : {}),
        });
        return { task: snapshot(), moved: true };
      });
    }) as never,
    ...{},
  };

  harness.store = store as TaskStore;
  return harness;
}

/**
 * FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
 * Reproduces `specifyTask`'s OWN generation capture (`this.activePlanningGenerations.set(id,
 * this.resetFence.currentGeneration(id))`) so a finalize driven directly carries the generation a
 * real planning pass would have recorded, and exposes the PRODUCTION reset surface used to replace
 * the attempt. Without the seed the guard sees `planningGeneration: undefined` — the honest answer for
 * a recovery-initiated finalize, but not the case under test.
 */
function planningResetHandles(processor: TriageProcessor, taskId: string): { replaceAttempt: () => void } {
  const internals = processor as unknown as {
    resetFence: { currentGeneration: (id: string) => number; cancelPlanning: (id: string) => void };
    activePlanningGenerations: Map<string, number>;
  };
  internals.activePlanningGenerations.set(taskId, internals.resetFence.currentGeneration(taskId));
  return { replaceAttempt: () => internals.resetFence.cancelPlanning(taskId) };
}

/** Mailbox double: production's archive path delivers through `sendMessageOnce` with a dedup key. */
function messageStoreDouble(harness: StoreHarness, reject = false) {
  return {
    sendMessageOnce: vi.fn(async (message: { content: string }, dedupeKey: string) => {
      if (reject) throw new Error("mailbox unavailable");
      harness.mailbox.push({ content: message.content, dedupeKey });
    }),
  };
}

/*
FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
Per-REVISION fake git. The whole defect class was a responder that could not distinguish revisions,
so every fixture here encodes both `main` and the task branch and answers ONLY by the sha argv slot.
*/
interface RevisionAnswers {
  /** Revisions in which the cited construct exists. */
  constructPresentOn: string[];
  /** Revisions whose tree the positive control can sample successfully. */
  controlOkOn?: string[];
  /** Revisions for which the grep probe ERRORS instead of answering. */
  probeErrorsOn?: string[];
  branchTip?: string;
  baseCommit?: string;
  baselineHead?: string;
}

function revisionExec(answers: RevisionAnswers, record?: { cwd: string; argv: string[] }[]) {
  const controlLine = "export const knownControl = true;";
  const exec = async (argv: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    record?.push({ cwd: opts?.cwd ?? "", argv });
    const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
    const miss = () => ({ stdout: "", stderr: "", exitCode: 1 });
    const err = () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
    const controlOk = (answers.controlOkOn ?? answers.constructPresentOn).length > 0;

    switch (argv[1]) {
      case "for-each-ref": {
        const refName = argv[3];
        if (answers.branchTip && refName === "refs/heads/fusion/T-1") return ok(`${refName} ${answers.branchTip}`);
        return ok("");
      }
      case "rev-parse": {
        const spec = argv[2] ?? "";
        if (spec === "--git-common-dir") return ok("/repo/.git");
        if (spec === "HEAD^{commit}") return answers.baselineHead ? ok(answers.baselineHead) : err();
        const bare = spec.replace(/\^\{commit\}$/, "");
        if (bare === "refs/heads/fusion/T-1" && answers.branchTip) return ok(answers.branchTip);
        if (/^[0-9a-f]{40,64}$/.test(bare)) return ok(bare);
        return err();
      }
      case "cat-file": {
        const target = argv[3] ?? "";
        if (target.endsWith("^{commit}")) return ok();
        return miss();
      }
      case "status":
        return ok("");
      case "ls-tree":
        return controlOk ? ok("src/App.ts") : miss();
      case "show":
        return controlOk ? ok(controlLine) : miss();
      case "grep": {
        const raw = argv[4] ?? "";
        const rev = argv[5] ?? "";
        if ((answers.probeErrorsOn ?? []).includes(rev)) return err();
        if (raw === controlLine) return answers.controlOkOn?.includes(rev) ?? controlOk ? ok("src/App.ts:1:" + raw) : miss();
        return answers.constructPresentOn.includes(rev) ? ok(`src/a.ts:1:${raw}`) : miss();
      }
      default:
        return err();
    }
  };
  return exec;
}

describe("GhostBug ghost-bug task-revision caller regression", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixtureRoot(taskId: string, promptContent: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "fusion-ghost-caller-"));
    roots.push(root);
    await mkdir(join(root, ".fusion", "tasks", taskId), { recursive: true });
    await writeFile(join(root, ".fusion", "tasks", taskId, "PROMPT.md"), promptContent, "utf-8");
    return root;
  }

  /** Drives the REAL finalizer body — the production site of the ghost-bug guard. */
  async function runFinalize(
    harness: StoreHarness,
    rootDir: string,
    task: Task,
    written: string,
    probeExec: ProbeExec,
    messageStore?: ReturnType<typeof messageStoreDouble>,
  ): Promise<void> {
    const processor = new TriageProcessor(harness.store, rootDir, {
      ghostBugProbeExec: probeExec,
      ...(messageStore ? { messageStore } : {}),
    });
    await (processor as unknown as {
      finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
    }).finalizeApprovedTask(task, written, { requirePlanApproval: false } as Settings);
  }


  async function runTimedOutFinalize(harness: StoreHarness, rootDir: string, task: Task, written: string): Promise<void> {
    let reached!: () => void;
    const probeReached = new Promise<void>((resolve) => { reached = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = runFinalize(harness, rootDir, task, written, () => { reached(); return NEVER_SETTLES([], undefined); });
      await probeReached;
      await vi.advanceTimersByTimeAsync(15001);
      await result;
    } finally { vi.useRealTimers(); }
  }

  /** A release-path assertion: the card reached the ready lane through the real handoff. */
  function expectReleased(harness: StoreHarness) {
    expect(harness.row.column).toBe(HOLDING);
  }

  it("PRIMARY CORRECTED CASE: a construct present only on the task's unmerged branch is verified-present — no archive, no pause, normal release", async () => {
    const written = specFor("BUG-001");
    const rootDir = await fixtureRoot("BUG-001", written);
    const task = taskFixture({ id: "BUG-001", branch: "fusion/T-1", baseCommitSha: MAIN_SHA });
    const harness = createStoreHarness({ task: { ...task } });
    const calls: { cwd: string; argv: string[] }[] = [];

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [REVISION_SHA],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    }, calls));

    // The corrected outcome: released, not archived, not held.
    expectReleased(harness);
    expect(harness.row.paused).not.toBe(true);
    expect(harness.commits.filter((commit) => commit.toColumn === ARCHIVED)).toEqual([]);
    // The construct-bearing revision was actually grepped, and `main` was never the premise.
    const greps = calls.filter(({ argv }) => argv[1] === "grep" && argv[4] === "ghost_target_fn");
    expect(greps.length).toBeGreaterThan(0);
    expect(greps.some(({ argv }) => argv[5] === REVISION_SHA)).toBe(true);
    // No archive commit, so no decision record and no archive-side visibility rows.
    expect(harness.commits.some((commit) => commit.decisionAction)).toBe(false);
    expect(harness.activities).toEqual([]);
  });


  /** FNXC:GhostBugPreflight 2026-10-23-05:34: A real positive probe cannot authorize a plan or task episode replaced while the probe awaited. */
  it.each(["title", "description", "prompt", "branch", "checkout", "paused", "status", "missing"])("does not release a positive probe after a concurrent %s change", async (change) => {
    const id = "BUG-031";
    const written = specFor(id);
    const rootDir = await fixtureRoot(id, written);
    const task = taskFixture({ id, branch: "fusion/T-1", baseCommitSha: MAIN_SHA });
    const harness = createStoreHarness({ task: { ...task } });
    const probe = revisionExec({ constructPresentOn: [REVISION_SHA], branchTip: REVISION_SHA });
    let changed = false;
    await runFinalize(harness, rootDir, task, written, async (argv, options) => {
      const answer = await probe(argv, options);
      if (!changed && argv[1] === "grep" && argv[4] === "ghost_target_fn") {
        changed = true;
        if (change === "title") harness.applyRowChange({ title: "New plan title" });
        if (change === "description") harness.applyRowChange({ description: "Different cited code" });
        if (change === "prompt") await writeFile(join(rootDir, ".fusion", "tasks", id, "PROMPT.md"), "A different current plan");
        if (change === "branch") harness.applyRowChange({ branch: "fusion/newer" });
        if (change === "checkout") harness.applyRowChange({ checkoutLeaseEpoch: 2 });
        if (change === "paused") harness.applyRowChange({ paused: true, userPaused: true });
        if (change === "status") harness.applyRowChange({ status: "needs-replan" });
        if (change === "missing") vi.mocked(harness.store.getTask).mockResolvedValue(null as never);
      }
      return answer;
    });
    expect(changed).toBe(true);
    expect(harness.commits).toEqual([]);
    expect(harness.auditRows.some((row) => row.mutationType === "task:ghost-bug-preflight-superseded")).toBe(true);
    expect(harness.row.column).toBe(task.column);
    expect(harness.row.pausedReason).not.toBe("ghost-bug-preflight-unverified");
  });

  it("allows a positive probe after an unrelated activity-log update", async () => {
    const id = "BUG-032";
    const written = specFor(id);
    const rootDir = await fixtureRoot(id, written);
    const task = taskFixture({ id, branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });
    const probe = revisionExec({ constructPresentOn: [REVISION_SHA], branchTip: REVISION_SHA });
    await runFinalize(harness, rootDir, task, written, async (argv, options) => {
      const answer = await probe(argv, options);
      if (argv[1] === "grep" && argv[4] === "ghost_target_fn") await harness.store.logEntry(id, "Unrelated progress");
      return answer;
    });
    expectReleased(harness);
    expect(harness.row.log.some((entry) => entry.action === "Unrelated progress")).toBe(true);
  });

  it.each([undefined, null, ""])("archives a bug-fix task with a missing or blank title (%s)", async (title) => {
    const written = specFor("BUG-022");
    const rootDir = await fixtureRoot("BUG-022", written);
    const task = taskFixture({ id: "BUG-022", title, description: "Fix a bug: typecheck error in `ghost_target_fn`", branch: "fusion/T-1" } as never);
    const harness = createStoreHarness({ task: { ...task } });
    await runFinalize(harness, rootDir, task, written, revisionExec({ constructPresentOn: [], controlOkOn: [REVISION_SHA], branchTip: REVISION_SHA }));
    expect(harness.row.column).toBe(ARCHIVED);
  });

  it("LEGITIMATE ARCHIVE: genuine absence on the proven revision with a passing control archives transaction-atomically", async () => {
    const written = specFor("GhostBug");
    const rootDir = await fixtureRoot("GhostBug", written);
    const task = taskFixture({ id: "GhostBug", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });
    const priorLogLength = (task.log ?? []).length;

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    }), messageStoreDouble(harness));

    // ONE commit carries BOTH the decision and the transition.
    const archiveCommits = harness.commits.filter((commit) => commit.moved && commit.toColumn === ARCHIVED);
    expect(archiveCommits).toHaveLength(1);
    expect(archiveCommits[0].decisionAction).toContain(GHOST_BUG_ARCHIVE_REASON);
    expect(harness.row.column).toBe(ARCHIVED);

    // Prior history SURVIVES the fenced append (a stripped-read clobber fails here).
    expect(harness.row.log!.length).toBe(priorLogLength + 1);
    expect(harness.row.log![0].action).toBe("Task created");

    // ZERO post-commit `logEntry` attempts — structural, not a count a suppressed write could satisfy.
    expect(harness.logEntryAttempts).toEqual([]);

    // Post-commit bookkeeping is exactly the three SEPARATE entities.
    expect(harness.activities).toHaveLength(1);
    expect(harness.activities[0].type).toBe("task:auto-archived-ghost-bug");
    expect(harness.activities[0].metadata).toMatchObject({ revisionSource: "task-branch", revisionSha: REVISION_SHA });
    expect(harness.auditRows.some((row) => row.mutationType === "task:auto-archived-ghost-bug-visibility")).toBe(true);
    await vi.waitFor(() => expect(harness.mailbox).toHaveLength(1));
    expect(harness.mailbox[0].dedupeKey).toBe("ghost-bug-archive:GhostBug");
  });

  it("NO ARCHIVE OF A NEWER EPISODE: an input change inside the commit window moves nothing and leaves zero lifecycle records", async () => {
    const written = specFor("BUG-003");
    const rootDir = await fixtureRoot("BUG-003", written);
    const task = taskFixture({ id: "BUG-003", branch: "fusion/T-1" });
    const harness = createStoreHarness({
      task: { ...task },
      // A newer planning pass edits the description right at the seam's bounded re-check await.
      onAfterPredicate: (inner) => { inner.applyRowChange({ description: "A COMPLETELY DIFFERENT SPEC" }); },
    });

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    }), messageStoreDouble(harness));

    expect(harness.row.column).not.toBe(ARCHIVED);
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    // No decision, no activity, no mailbox item on the changed row.
    expect(harness.commits.some((commit) => commit.decisionAction)).toBe(false);
    expect(harness.activities).toEqual([]);
    expect(harness.mailbox).toEqual([]);
    // And no pause of the newer row either — an episode-superseded completion mutates nothing.
    expect(harness.row.paused).not.toBe(true);
    expect(harness.row.log!.length).toBe(1);
  });

  /**
   * The shared assertion for every BLOCKING outcome: the card is held visibly, released to nobody,
   * and archived by nothing. Sharing it rather than repeating it is deliberate — the whole point is
   * that the four unresolved causes are INDISTINGUISHABLE in their effect on the board.
   */
  async function expectHeldNotReleased(
    harness: StoreHarness,
    rootDir: string,
    written: string,
    task: Task,
    answers: RevisionAnswers,
    expectedReason: string,
  ) {
    await runFinalize(harness, rootDir, task, written, revisionExec(answers));

    // The hold is APPLIED: pause + the fixed reason + its history entry, from the ONE atomic write.
    expect(harness.row.paused).toBe(true);
    expect(harness.row.pausedReason).toBe("ghost-bug-preflight-unverified");
    expect(harness.row.pausedByAgentId).toBe("triage");
    const holdEntry = harness.row.log!.find((entry) => entry.action.startsWith("Ghost-bug preflight could not verify"));
    expect(holdEntry).toBeDefined();
    expect(holdEntry!.outcome).toContain(expectedReason);

    // Never released, never archived.
    expect(harness.row.column).toBe("triage");
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    expect(harness.logEntryAttempts).toEqual([]);
    expect(harness.auditRows.some((entry) => entry.mutationType === "task:ghost-bug-preflight-unverified")).toBe(true);
  }

  it("BLOCKING WITHOUT ARCHIVE AND WITHOUT RELEASE: a task with no resolvable revision holds the card", async () => {
    const written = specFor("BUG-004A");
    const rootDir = await fixtureRoot("BUG-004A", written);
    const task = taskFixture({ id: "BUG-004A", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });
    await expectHeldNotReleased(harness, rootDir, written, task, { constructPresentOn: [], controlOkOn: [REVISION_SHA], baselineHead: undefined, branchTip: undefined }, "revision_unresolved");
  });

  it("BLOCKING WITHOUT ARCHIVE AND WITHOUT RELEASE: an option-looking branch name holds the card", async () => {
    const written = specFor("BUG-004B");
    const rootDir = await fixtureRoot("BUG-004B", written);
    const task = taskFixture({ id: "BUG-004B", branch: "--help" });
    const harness = createStoreHarness({ task: { ...task } });
    await expectHeldNotReleased(harness, rootDir, written, task, { constructPresentOn: [], controlOkOn: [REVISION_SHA], branchTip: REVISION_SHA, baselineHead: MAIN_SHA }, "revision_unsafe_ref");
  });

  it("BLOCKING WITHOUT ARCHIVE AND WITHOUT RELEASE: a failing positive control holds the card", async () => {
    const written = specFor("BUG-004C");
    const rootDir = await fixtureRoot("BUG-004C", written);
    const task = taskFixture({ id: "BUG-004C", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });
    await expectHeldNotReleased(harness, rootDir, written, task, { constructPresentOn: [], controlOkOn: [], branchTip: REVISION_SHA, baselineHead: MAIN_SHA }, "probe_control_failed");
  });

  it("BLOCKING WITHOUT ARCHIVE AND WITHOUT RELEASE: every probe erroring holds the card", async () => {
    const written = specFor("BUG-004D");
    const rootDir = await fixtureRoot("BUG-004D", written);
    const task = taskFixture({ id: "BUG-004D", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });
    await expectHeldNotReleased(harness, rootDir, written, task, { constructPresentOn: [], controlOkOn: [REVISION_SHA], probeErrorsOn: [REVISION_SHA], branchTip: REVISION_SHA, baselineHead: MAIN_SHA }, "probe_evidence_incomplete");
  });

  it("PARTIAL PROBE ERRORS are never reduced to all-definitively-missing", async () => {
    const written = "# Task: BUG-005 - fix: typecheck error\n\n## Original Description\n\n`ghost_target_fn` and `second_item` are broken.\n\n## Steps\n\n### Step 0: Implement\n\n- [ ] Do the work\n";
    const rootDir = await fixtureRoot("BUG-005", written);
    const task = taskFixture({ id: "BUG-005", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    // One construct definitively missing, the other's probe ERRORS: the old code archived on this.
    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      probeErrorsOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    }));

    expect(harness.row.column).not.toBe(ARCHIVED);
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    expect(harness.row.paused).toBe(true);
    expect(harness.row.log!.find((entry) => entry.outcome?.includes("probe_evidence_incomplete"))).toBeDefined();
  });

  it("THE 15s TIMEOUT PATH holds instead of releasing as if verified", async () => {
    const written = specFor("BUG-006");
    const rootDir = await fixtureRoot("BUG-006", written);
    const task = taskFixture({ id: "BUG-006", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    // A probe exec that never settles — the exact shape of the old fail-open timeout.
    await runTimedOutFinalize(harness, rootDir, task, written);

    expect(harness.row.paused).toBe(true);
    expect(harness.row.pausedReason).toBe("ghost-bug-preflight-unverified");
    expect(harness.row.column).toBe("triage");
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    expect(harness.row.log!.find((entry) => entry.outcome?.includes("preflight_timeout"))).toBeDefined();
  });

  it("A THROWN preflight holds instead of logging 'failed open' and releasing", async () => {
    const written = specFor("BUG-007");
    const rootDir = await fixtureRoot("BUG-007", written);
    const task = taskFixture({ id: "BUG-007", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    await runFinalize(harness, rootDir, task, written, (async () => {
      throw new Error("git spawn failed");
    }) as never);

    expect(harness.row.paused).toBe(true);
    expect(harness.row.pausedReason).toBe("ghost-bug-preflight-unverified");
    expect(harness.row.column).toBe("triage");
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
  });

  it("GENUINELY INAPPLICABLE tasks release normally and are never held", async () => {
    const written = "# Task: BUG-008 - chore: refresh fixtures\n\n## Original Description\n\nRegenerate the golden files.\n\n## Steps\n\n### Step 0: Implement\n\n- [ ] Do the work\n";
    const rootDir = await fixtureRoot("BUG-008", written);
    const task = taskFixture({
      id: "BUG-008",
      title: "BUG-008 chore: refresh fixtures",
      description: "Regenerate the golden files and commit them.",
      branch: "fusion/T-1",
    });
    const harness = createStoreHarness({ task: { ...task } });

    // The exec would BLOCK forever: a genuinely-inapplicable pass must never reach it.
    await runFinalize(harness, rootDir, task, written, NEVER_SETTLES);

    expectReleased(harness);
    expect(harness.row.paused).not.toBe(true);
  });

  it("LEGITIMATE ARCHIVE: a proven branch needs no baseline HEAD", async () => {
    const written = specFor("BUG-009");
    const rootDir = await fixtureRoot("BUG-009", written);
    const task = taskFixture({ id: "BUG-009", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
    }), messageStoreDouble(harness));

    expect(harness.row.column).toBe(ARCHIVED);
  });

  /*
  FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
  THE TWO FENCES GUARD DIFFERENT THINGS, AND THE TESTS MIRROR THAT SPLIT.

  • The PROMPT-BYTES proof is a FILE read and lives at the engine-side episode pre-check. It is what
    catches a newer planning pass having republished the spec while these probes ran — the counter-
    example the old `id + branch + column` check could never see.
  • The ROW proof lives in the move transaction's own commit-time re-check (column, consumed
    title/description, status, execution, pause, branch/worktree/base, checkout lease, durable
    updatedAt). That is what catches a row change inside the commit window — covered by the
    `NO ARCHIVE OF A NEWER EPISODE` and `PERSISTENCE-HONESTY` cases, which mutate ROW fields rather
    than the artifact.

  A rewrite is therefore injected from INSIDE the probe exec: by the time the pre-check runs, the
  artifact has genuinely moved, exactly as it would in the real race.
  */
  it("PROMPT-ONLY A→B COUNTEREXAMPLE AT THE ARCHIVE BOUNDARY: the old attempt archives nothing", async () => {
    const promptA = specFor("BUG-010");
    const promptB = promptA + "\n## Post-finalize revision\n\nRepublished by a newer planning pass.\n";
    const rootDir = await fixtureRoot("BUG-010", promptA);
    const task = taskFixture({ id: "BUG-010", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    let republished = false;
    const base = revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    });
    const exec: ProbeExec = async (argv, opts) => {
      if (!republished) {
        republished = true;
        await writeFile(join(rootDir, ".fusion", "tasks", "BUG-010", "PROMPT.md"), promptB, "utf-8");
      }
      return base(argv, opts);
    };

    await runFinalize(harness, rootDir, task, promptA, exec, messageStoreDouble(harness));

    // Same id, same ref, same column — only the consumed PROMPT bytes moved. Nothing may land.
    expect(republished).toBe(true);
    expect(harness.row.column).toBe("triage");
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    expect(harness.row.paused).not.toBe(true);
    expect(harness.activities).toEqual([]);
    expect(harness.auditRows.some((entry) => entry.mutationType === "task:ghost-bug-preflight-superseded")).toBe(true);
    // The newer bytes survive untouched — the stale pass never rewrote the spec.
    expect(await readFile(join(rootDir, ".fusion", "tasks", "BUG-010", "PROMPT.md"), "utf-8")).toBe(promptB);
  });

  it("PROMPT-ONLY A→B TIMEOUT COUNTEREXAMPLE AT THE HOLD BOUNDARY: no pause of the newer episode", async () => {
    const promptA = specFor("BUG-011");
    const promptB = promptA + "\n## Post-finalize revision\n\nRepublished by a newer planning pass.\n";
    const rootDir = await fixtureRoot("BUG-011", promptA);
    const task = taskFixture({ id: "BUG-011", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    /*
    Title/description/branch/column/lease fields all stay UNCHANGED — the pre-fix hold predicate saw
    an identical row and paused it. The rewrite happens DURING the hung probe, so only the artifact
    bytes differ by the time the hold boundary re-reads them.
    */
    /*
    The resolver and the positive control must SUCCEED, or the pipeline never reaches a grep and the
    hang has nothing to race against. So: an otherwise-working exec that hangs on the FIRST construct
    probe, having just republished the spec — resolution succeeds, probes never complete, and only the
    artifact bytes differ by the time the hold boundary re-reads them.
    */
    const base = revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    });
    let republished = false;
    let signalRewritten!: () => void;
    const rewritten = new Promise<void>((resolve) => { signalRewritten = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled: ProbeExec = async (argv, opts) => {
      if (argv[1] === "grep" && !republished) {
        republished = true;
        await writeFile(join(rootDir, ".fusion", "tasks", "BUG-011", "PROMPT.md"), promptB, "utf-8");
        signalRewritten();
        return new Promise<never>(() => undefined);
      }
      return base(argv, opts);
    };
    try {
      const result = runFinalize(harness, rootDir, task, promptA, stalled);
      await rewritten;
      await vi.advanceTimersByTimeAsync(15001);
      await result;
    } finally { vi.useRealTimers(); }
    expect(republished).toBe(true);

    // B is NOT paused, no task-log entry was added, and nothing was handed off.
    expect(harness.row.paused).not.toBe(true);
    expect(harness.row.log!.length).toBe(1);
    expect(harness.row.column).toBe("triage");
    expect(harness.auditRows.some((entry) => entry.mutationType === "task:ghost-bug-preflight-superseded")).toBe(true);
  });

  it("SAME-EPISODE TIMEOUT POSITIVE CONTROL: an unchanged PROMPT artifact durably holds", async () => {
    const written = specFor("BUG-012");
    const rootDir = await fixtureRoot("BUG-012", written);
    const task = taskFixture({ id: "BUG-012", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    await runTimedOutFinalize(harness, rootDir, task, written);

    expect(harness.row.paused).toBe(true);
    expect(harness.row.pausedReason).toBe("ghost-bug-preflight-unverified");
    const holdEntries = harness.row.log!.filter((entry) => entry.action.startsWith("Ghost-bug preflight could not verify"));
    expect(holdEntries).toHaveLength(1);
  });

  it("REPLACED PLANNING ATTEMPT: a stale generation routes to stale-completion for both archive and hold", async () => {
    const written = specFor("BUG-013");
    const rootDir = await fixtureRoot("BUG-013", written);
    const task = taskFixture({ id: "BUG-013", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    let cancelled = false;
    const exec: ProbeExec = async (argv, opts) => {
      if (!cancelled) {
        // Cancelled AFTER dispatch captured its generation — the real reset-then-replan ordering.
        cancelled = true;
        handles.replaceAttempt();
      }
      return base(argv, opts);
    };
    const processor = new TriageProcessor(harness.store, rootDir, { ghostBugProbeExec: exec });
    const base = revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    });
    const handles = planningResetHandles(processor, "BUG-013");

    await (processor as unknown as {
      finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
    }).finalizeApprovedTask(task, written, { requirePlanApproval: false } as Settings);

    expect(cancelled).toBe(true);

    expect(harness.row.column).toBe("triage");
    expect(harness.row.paused).not.toBe(true);
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    expect(harness.row.log!.length).toBe(1);
  });

  it("REPLACED PLANNING ATTEMPT AT THE HOLD BOUNDARY: a stale generation pauses nothing", async () => {
    const written = specFor("BUG-013B");
    const rootDir = await fixtureRoot("BUG-013B", written);
    const task = taskFixture({ id: "BUG-013B", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    let cancelled = false;
    const processor = new TriageProcessor(harness.store, rootDir, {
      ghostBugProbeExec: async () => {
        if (!cancelled) {
          cancelled = true;
          handlesB.replaceAttempt();
        }
        return new Promise<never>(() => undefined);
      },
    });
    const handlesB = planningResetHandles(processor, "BUG-013B");

    await (processor as unknown as {
      finalizeApprovedTask(task: Task, writtenInput: string, settings: Settings): Promise<void>;
    }).finalizeApprovedTask(task, written, { requirePlanApproval: false } as Settings);

    expect(cancelled).toBe(true);
    // The NEWER episode is not paused and carries no history entry from the old attempt.
    expect(harness.row.paused).not.toBe(true);
    expect(harness.row.log!.length).toBe(1);
    expect(harness.auditRows.some((entry) => entry.mutationType === "task:ghost-bug-preflight-superseded")).toBe(true);
  });

  it("AN OLD TIMEOUT HANDLER ARRIVING AFTER THE ROW ADVANCED mutates nothing", async () => {
    const written = specFor("BUG-014");
    const rootDir = await fixtureRoot("BUG-014", written);
    const task = taskFixture({ id: "BUG-014", branch: "fusion/T-1" });
    const harness = createStoreHarness({
      task: { ...task },
      // The scheduler advances the card while the preflight is still running.
      onAfterPredicate: (inner) => { inner.applyRowChange({ column: "in-progress", executionStartedAt: "2026-10-11T13:00:00.000Z" }); },
    });

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
    }) as never);

    expect(harness.row.paused).not.toBe(true);
    expect(harness.row.log!.length).toBe(1);
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
  });

  it("DURABLE REVISION FENCE ON THE HOLD: a cross-process row movement refuses the pause", async () => {
    const written = specFor("BUG-015");
    const rootDir = await fixtureRoot("BUG-015", written);
    const task = taskFixture({ id: "BUG-015", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task }, refuseHoldFence: true });

    await runTimedOutFinalize(harness, rootDir, task, written);

    // Refused: no pause, no history entry, no release, and NO false durable-hold claim.
    expect(harness.row.paused).not.toBe(true);
    expect(harness.row.log!.length).toBe(1);
    expect(harness.row.column).toBe("triage");
    const notApplied = harness.auditRows.filter((entry) => entry.mutationType === "task:ghost-bug-preflight-unverified");
    expect(notApplied.length).toBeGreaterThan(0);
    expect(notApplied[0].metadata).toMatchObject({ holdOutcome: "not-applied" });
  });

  it("ONE ATOMIC WRITE CARRIES THE PAUSE AND ITS HISTORY", async () => {
    const written = specFor("BUG-016");
    const rootDir = await fixtureRoot("BUG-016", written);
    const task = taskFixture({ id: "BUG-016", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });
    const updateSpy = vi.spyOn(harness.store, "updateTaskUnlocked");

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      probeErrorsOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
    }) as never);

    const holdWrite = updateSpy.mock.calls.find(([, patch]) => (patch as Record<string, unknown>).paused === true);
    expect(holdWrite).toBeDefined();
    const patch = holdWrite![1] as Record<string, unknown>;
    // PAUSE FIELDS AND HISTORY IN THE SAME PATCH — never a pause then a later logEntry.
    expect(patch.pausedReason).toBe("ghost-bug-preflight-unverified");
    expect(Array.isArray(patch.log)).toBe(true);
    expect((patch.log as TaskLogEntry[]).some((entry) => entry.action.startsWith("Ghost-bug preflight could not verify"))).toBe(true);
    // The fence rode the write, so a cross-process mover cannot be clobbered.
    expect(holdWrite![4]).toMatchObject({ expectedUpdatedAt: expect.any(String) });
    // And no separate lifecycle log write followed it.
    expect(harness.logEntryAttempts).toEqual([]);
  });

  it("PERSISTENCE-HONESTY ON THE ARCHIVE: a mismatching expected record lands nothing and claims nothing", async () => {
    const written = specFor("BUG-017");
    const rootDir = await fixtureRoot("BUG-017", written);
    const task = taskFixture({ id: "BUG-017", branch: "fusion/T-1" });
    const harness = createStoreHarness({
      task: { ...task },
      onAfterPredicate: (inner) => { inner.applyRowChange({ status: "planning", description: "changed" }); },
    });

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
    }) as never, messageStoreDouble(harness));

    const refused = harness.commits.filter((commit) => !commit.moved && commit.toColumn === ARCHIVED);
    expect(refused.length).toBeGreaterThan(0);
    expect(harness.row.column).not.toBe(ARCHIVED);
    expect(harness.commits.some((commit) => commit.decisionAction)).toBe(false);
    expect(harness.activities).toEqual([]);
    // Honest record only — no rollback claim, because nothing landed.
    expect(harness.auditRows.some((entry) => entry.mutationType === "task:ghost-bug-preflight-superseded")).toBe(true);
  });

  it("A REJECTING POST-COMMIT VISIBILITY WRITE LEAVES THE ARCHIVE LANDED AND RECORDS THE GAP", async () => {
    const written = specFor("BUG-018");
    const rootDir = await fixtureRoot("BUG-018", written);
    const task = taskFixture({ id: "BUG-018", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task }, rejectPostCommitActivity: true });

    await runFinalize(harness, rootDir, task, written, revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
    }) as never, messageStoreDouble(harness, true));

    // The archive stays landed; only the visibility gap is recorded.
    expect(harness.row.column).toBe(ARCHIVED);
    expect(harness.activities).toEqual([]);
    expect(harness.mailbox).toEqual([]);
    await vi.waitFor(() => {
      expect(harness.auditRows.some((entry) => entry.mutationType === "task:auto-archived-ghost-bug-visibility-gap")).toBe(true);
    });
  });

  it("THE BRANCH TARGET MOVING AFTER CAPTURE is a same-episode hold, never an archive", async () => {
    const written = specFor("BUG-019");
    const rootDir = await fixtureRoot("BUG-019", written);
    const task = taskFixture({ id: "BUG-019", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    /*
    The commit-time re-resolve resolves `<ref>^{commit}` through `rev-parse`, so the tip that MOVES
    is modelled there: the first answer is the captured revision, every later answer is a new commit
    pushed to the same branch while the probes ran.
    */
    let tipLookups = 0;
    const base = revisionExec({
      constructPresentOn: [],
      controlOkOn: [REVISION_SHA],
      branchTip: REVISION_SHA,
      baselineHead: MAIN_SHA,
    });
    const exec: ProbeExec = async (argv, opts) => {
      if (argv[1] === "rev-parse" && (argv[2] ?? "").startsWith("refs/heads/fusion/T-1")) {
        tipLookups += 1;
        if (tipLookups > 1) return { stdout: MOVED_SHA, stderr: "", exitCode: 0 };
      }
      return base(argv, opts);
    };

    await runFinalize(harness, rootDir, task, written, exec);

    expect(harness.row.column).toBe("triage");
    expect(harness.row.paused).toBe(true);
    expect(harness.row.pausedReason).toBe("ghost-bug-preflight-unverified");
    expect(harness.row.log!.find((entry) => entry.outcome?.includes("revision_moved_during_probe"))).toBeDefined();
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
  });

  /* ── Symptom Verification (the acceptance evidence) ───────────────────────
   *
   * FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
   * THE ORIGINAL SYMPTOM, REPRODUCED AGAINST A REAL GIT REPOSITORY WITH THE REAL DEFAULT EXEC.
   *
   * A synthetic temp repo holds a baseline commit on `main` WITHOUT `ghost_target_fn`, plus an
   * unmerged branch whose tip ADDS it, with the working tree left checked out on `main` — exactly the
   * wrong-revision probe root that archived a project task while `git show` on the
   * preserved commit proved the constructs existed. No network, no polling, a handful of local git
   * commands, and nothing from any real project.
   */
  it("SYMPTOM: a branch-only construct is FOUND at the task's proven revision by the real exec — no archive, normal release", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-ghost-symptom-"));
    roots.push(root);
    const git = async (...args: string[]) => {
      const result = await execFileAsync("git", args, { cwd: root });
      return String(result.stdout).trim();
    };
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "user.name", "Test");
    await writeFile(join(root, "src.ts"), "export const baseline = 1;\n");
    await git("add", "src.ts");
    await git("commit", "-m", "baseline");
    const mainSha = await git("rev-parse", "HEAD");

    // The unmerged branch adds the construct, then the tree goes BACK to main — the wrong-revision root.
    await git("checkout", "-b", "fusion/T-1");
    await writeFile(join(root, "src.ts"), "export const baseline = 1;\nexport function ghost_target_fn() { return 42; }\n");
    await git("add", "src.ts");
    await git("commit", "-m", "add ghost_target_fn");
    const branchSha = await git("rev-parse", "HEAD");
    await git("checkout", "main");

    // The premise of the old "all missing" verdict is proven gone: the branch revision DOES contain it.
    const grepOnBranch = await execFileAsync("git", ["grep", "-nF", "-e", "ghost_target_fn", branchSha, "--", ":/"], { cwd: root });
    expect(grepOnBranch.stdout).toContain("ghost_target_fn");
    // And on main it genuinely is absent — which is what used to be mistaken for a phantom bug.
    await expect(execFileAsync("git", ["grep", "-nF", "-e", "ghost_target_fn", mainSha, "--", ":/"], { cwd: root }))
      .rejects.toMatchObject({ code: 1 });

    const written = specFor("BUG-020");
    await mkdir(join(root, ".fusion", "tasks", "BUG-020"), { recursive: true });
    await writeFile(join(root, ".fusion", "tasks", "BUG-020", "PROMPT.md"), written, "utf-8");

    const task = taskFixture({ id: "BUG-020", branch: "fusion/T-1" });
    const harness = createStoreHarness({ task: { ...task } });

    // THE REAL DEFAULT EXEC — no fake responder anywhere in this case.
    await runFinalize(harness, root, task, written, createGhostBugProbeExec());

    expect(harness.row.column).toBe(HOLDING);
    expect(harness.row.paused).not.toBe(true);
    expect(harness.commits.filter((commit) => commit.toColumn === ARCHIVED)).toEqual([]);
  });

  /*
  FNXC:GhostBugPreflight 2026-10-11-14:40 (GhostBug):
  A cwd-STRING spy can never prove a child process did not run in a substituted directory, so this
  case builds a REAL substitution: a directory that still SPELLS as owned (it sits under
  `.fusion/worktrees/`) but whose real path escapes that root, backed by a DIFFERENT repository.
  Execution evidence is captured FIRST — what a real subprocess actually resolves from that cwd — and
  only then must the production ownership gate refuse it.
  */
  it("CANONICAL-TARGET SUBSTITUTION is refused by the real ownership gate, with the real default exec", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-ghost-owned-"));
    roots.push(root);
    const git = async (args: string[], cwd: string) => {
      const result = await execFileAsync("git", args, { cwd });
      return String(result.stdout).trim();
    };
    await git(["init", "-b", "main"], root);
    await git(["config", "user.email", "test@example.invalid"], root);
    await git(["config", "user.name", "Test"], root);
    await writeFile(join(root, "src.ts"), "export const baseline = 1;\nexport function ghost_target_fn() {}\n");
    await git(["add", "src.ts"], root);
    await git(["commit", "-m", "baseline"], root);

    // A genuinely DIFFERENT repository to substitute in.
    const substitute = await mkdtemp(join(tmpdir(), "fusion-ghost-foreign-"));
    roots.push(substitute);
    await git(["init", "-b", "main"], substitute);
    await git(["config", "user.email", "test@example.invalid"], substitute);
    await git(["config", "user.name", "Test"], substitute);
    await writeFile(join(substitute, "other.ts"), "export const foreign = 1;\n");
    await git(["add", "other.ts"], substitute);
    await git(["commit", "-m", "foreign"], substitute);

    await mkdir(join(root, ".fusion", "worktrees"), { recursive: true });
    const declaredWorktree = join(root, ".fusion", "worktrees", "T-1");
    await symlink(substitute, declaredWorktree, process.platform === "win32" ? "junction" : "dir");

    // REAL EXECUTION EVIDENCE: a subprocess at the owned-LOOKING cwd is really inside the substitute.
    expect(await git(["rev-parse", "--show-toplevel"], declaredWorktree)).not.toBe(root);
    expect(await git(["rev-parse", "--git-common-dir"], declaredWorktree)).not.toContain(join(root, ".git"));

    const written = specFor("BUG-021");
    await mkdir(join(root, ".fusion", "tasks", "BUG-021"), { recursive: true });
    await writeFile(join(root, ".fusion", "tasks", "BUG-021", "PROMPT.md"), written, "utf-8");

    const task = taskFixture({ id: "BUG-021", branch: "main", worktree: declaredWorktree });
    const harness = createStoreHarness({ task: { ...task } });

    // THE REAL DEFAULT EXEC — no fake responder, so no fixture can be blamed for the outcome.
    await runFinalize(harness, root, task, written, createGhostBugProbeExec());

    // Refused closed: held for an operator, never released, never archived, nothing executed against
    // the substituted repository.
    expect(harness.row.paused).toBe(true);
    expect(harness.row.pausedReason).toBe("ghost-bug-preflight-unverified");
    expect(harness.row.column).toBe("triage");
    expect(harness.commits.filter((commit) => commit.moved)).toEqual([]);
    const holdEntry = harness.row.log!.find((entry) => entry.action.startsWith("Ghost-bug preflight could not verify"));
    expect(holdEntry?.outcome).toContain("worktree_provenance_foreign_path");
  });
});
