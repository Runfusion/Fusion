/*
 * Surface enumeration: engine-side recovery sweep; no desktop/mobile UI surface applies (the failed
 * badge disappears through the same status/error clear the operator's retry already produced).
 *
 * FNXC:AcquisitionConflictRevalidation 2026-11-01-13:55 (RUFU-356):
 * These cases run against a REAL git repository rather than a mocked probe on purpose. The claim this
 * sweep makes is "live git says the conflict is gone", and a stubbed probe would let the sweep pass by
 * trusting an absence nobody proved — the RUFU-376 phantom-worktree defect in a new costume. The
 * candidate gates are exercised exactly as sharply (they run before any probe), and the refusing
 * variants are the negative controls: same repository, same commits, one surviving physical side.
 *
 * Invariants pinned here:
 * - the CANDIDATE is the outer park envelope plus `status: "failed"`, never inner conflict wording, and
 *   never a neighbouring error family (base-diverged, the review-lane sentence, the executor's wording);
 * - a cleared card is cleared IN PLACE: `{ status: null, error: null }` and nothing else — no move, no
 *   branch/worktree wipe, no counter reset — byte-compatible with the operator's `fn_task_retry` clear;
 * - a live registration or an unattributed foreign tip keeps the error BYTE-IDENTICAL;
 * - `-no-action` is emitted once per (card, reason), so a persistent refusal stays countable without
 *   re-announcing itself at the hourly cadence forever;
 * - an absent, throwing, rejecting, or hanging audit sink cannot stop the clear (FN-9175).
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const git = (cwd: string, argv: string) =>
  execSync(`git ${argv}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

const TASK_ID = "RUFU-3561";
const BRANCH = `fusion/${TASK_ID.toLowerCase()}`;
const CLEARED = "task:reconcile-stale-acquisition-conflict";
const NO_ACTION = "task:reconcile-stale-acquisition-conflict-no-action";

/** The heartbeat retry-cap sentence, in the shape the park composes it (envelope + git's own detail). */
function parkEnvelope(detail: string): string {
  return `Worktree acquisition failed after 3 heartbeat attempts for branch "${BRANCH}": ${detail}`;
}

interface Fixture {
  repoDir: string;
  pinnedPath: string;
  adminDir: string;
}

function repoFixture(): Fixture {
  const repoDir = mkdtempSync(join(tmpdir(), "rufu-356-sweep-"));
  git(repoDir, "init -q -b main");
  git(repoDir, "config user.email sweep@example.invalid");
  git(repoDir, "config user.name Sweep");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  writeFileSync(join(repoDir, ".gitignore"), ".fusion/worktrees/\n");
  git(repoDir, "add -A");
  git(repoDir, 'commit -q -m "chore: seed"');
  const pinnedPath = join(repoDir, ".fusion", "worktrees", TASK_ID.toLowerCase());
  mkdirSync(join(repoDir, ".fusion", "worktrees"), { recursive: true });
  return { repoDir, pinnedPath, adminDir: join(repoDir, ".git", "worktrees", basename(pinnedPath)) };
}

function commitIn(path: string, subject: string, message?: string): void {
  writeFileSync(join(path, `note-${Math.random().toString(36).slice(2)}.txt`), subject);
  git(path, "add -A");
  git(path, message ? `commit -q -m "${subject}" -m "${message}"` : `commit -q -m "${subject}"`);
}

/** The refused state as it stood at park time: the card's branch checked out at its pinned destination. */
function registerCardWorktree(f: Fixture): void {
  git(f.repoDir, `worktree add -q -b ${BRANCH} "${f.pinnedPath}" HEAD`);
}

/** Build the parked card the way the heartbeat cap leaves it (rebound lane, failed, envelope carried). */
function parkedTask(checkout: Fixture | string, overrides: Record<string, unknown> = {}): Task {
  const pinnedPath = typeof checkout === "string" ? checkout : checkout.pinnedPath;
  return {
    id: TASK_ID,
    title: "Recover a card stranded by a stale acquisition conflict",
    description: "",
    column: "todo",
    status: "failed",
    branch: BRANCH,
    worktree: pinnedPath,
    error: parkEnvelope(
      `Branch ${BRANCH} is already checked out at ${pinnedPath} (tip 6efff2d2c92f, 1 stranded commit since main). Preserve this unregistered branch and inspect its foreign or unattributed commits before retrying.`,
    ),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    columnMovedAt: new Date(Date.now() - 60_000).toISOString(),
    recoveryRetryCount: null,
    workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

/** Trait-driven column model: `todo` is the intake (rebound) lane, `wip`/`done` are not. */
function codingIr(): WorkflowIr {
  return {
    version: "v2",
    columns: [
      { id: "todo", name: "Ready", traits: [{ trait: "intake" }] },
      { id: "wip", name: "WIP", traits: [{ trait: "in-progress" }] },
      { id: "done", name: "Done", traits: [{ trait: "done" }] },
    ],
    nodes: [
      { id: "plan", type: "prompt", column: "todo" },
      { id: "execute", type: "prompt", column: "wip" },
    ],
    edges: [],
  } as unknown as WorkflowIr;
}

interface HarnessOptions {
  settings?: Partial<Settings>;
  ir?: WorkflowIr | null;
  executingIds?: Set<string>;
  /** Audit-sink health: FN-9175 requires the clear to survive every hostile variant. */
  sink?: "ok" | "absent" | "throwing" | "rejecting" | "hanging";
  /** Simulates a concurrent write landing between the page read and the fenced write. */
  driftBeforeWrite?: (live: Task) => void;
}

function harness(task: Task, rootDir: string, options: HarnessOptions = {}) {
  const audit: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const moves: string[] = [];
  const logged: string[] = [];
  const ir = options.ir === undefined ? codingIr() : options.ir;
  const record = async (event: Record<string, unknown>) => { audit.push(event); };
  const store = {
    getSettings: async () => ({ globalPause: false, enginePaused: false, ...options.settings } as Settings),
    listTasks: async () => [task],
    getTask: async (id: string) => (id === task.id ? task : undefined),
    updateTask: async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      Object.assign(task, patch);
    },
    // Real semantics: the updater runs against the live row and returning `null` aborts the write.
    updateTaskAtomic: async (_id: string, updater: (live: Task) => unknown) => {
      options.driftBeforeWrite?.(task);
      const patch = await updater(task);
      if (patch) {
        updates.push(patch as Record<string, unknown>);
        Object.assign(task, patch);
      }
      return task;
    },
    moveTask: async (id: string) => { moves.push(id); },
    logEntry: async (_id: string, message: string) => { logged.push(message); },
    getTaskWorkflowSelection: () => (ir ? { workflowId: "wf-356" } : null),
    getWorkflowDefinition: async (id: string) => (id === "wf-356" && ir ? { ir } : undefined),
    listWorkflowDefinitions: async () => (ir ? [{ ir }] : []),
    getRootDir: () => rootDir,
    getTasksDir: () => "",
  } as unknown as Record<string, unknown>;
  if (options.sink !== "absent") {
    store.recordRunAuditEvent =
      options.sink === "throwing" ? () => { throw new Error("audit sink offline"); }
        : options.sink === "rejecting" ? () => Promise.reject(new Error("audit sink offline"))
          : options.sink === "hanging" ? () => new Promise(() => undefined)
            : record;
  }
  const manager = new SelfHealingManager(store as unknown as TaskStore, {
    rootDir,
    getExecutingTaskIds: () => options.executingIds ?? new Set<string>(),
  });
  return { task, store, audit, updates, moves, logged, manager };
}

const rowsOf = (audit: Array<Record<string, unknown>>, mutationType: string) =>
  audit.filter((event) => event.mutationType === mutationType);

const repos: string[] = [];
function trackedFixture(): Fixture {
  const f = repoFixture();
  repos.push(f.repoDir);
  return f;
}

describe("reconcileStaleAcquisitionConflicts (RUFU-356)", () => {
  it("releases the RUFU-278 shape in place: three-way absence, own work intact, no move, no wipe", async () => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, `feat(${TASK_ID}): own work`, `Fusion-Task-Id: ${TASK_ID}`);
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const task = parkedTask(f.pinnedPath);
    const before = JSON.stringify({ branch: task.branch, worktree: task.worktree, column: task.column });
    const { updates, moves, audit, manager } = harness(task, f.repoDir);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(1);

    // The clear is exactly the operator retry's two fields — nothing else may ride along.
    expect(updates).toEqual([{ status: null, error: null }]);
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    // In place: no column move, and the branch/worktree identity is left for acquisition to re-bind.
    expect(moves).toEqual([]);
    expect(JSON.stringify({ branch: task.branch, worktree: task.worktree, column: task.column })).toBe(before);

    const cleared = rowsOf(audit, CLEARED);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ target: TASK_ID, domain: "database" });
    expect(cleared[0]!.metadata).toMatchObject({
      taskId: TASK_ID,
      column: "todo",
      priorStatus: "failed",
      code: "premise-cleared",
      outcome: "cleared",
    });
    // ids and fixed enums only: no branch name, no path, no refusal sentence, no sha.
    expect(Object.keys(cleared[0]!.metadata as object).sort()).toEqual(
      ["code", "column", "outcome", "priorStatus", "taskId"].sort(),
    );
    expect(rowsOf(audit, NO_ACTION)).toEqual([]);
    expect(existsSync(f.pinnedPath)).toBe(false);
  });

  it("keeps the error byte-identical while the branch is checked out on a live path", async () => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, `feat(${TASK_ID}): live work`, `Fusion-Task-Id: ${TASK_ID}`);

    const task = parkedTask(f.pinnedPath);
    const errorBefore = task.error;
    const { updates, audit, manager } = harness(task, f.repoDir);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(task.error).toBe(errorBefore);
    expect(task.status).toBe("failed");
    const refused = rowsOf(audit, NO_ACTION);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.metadata).toMatchObject({ code: "live-registration", outcome: "no-action" });
  });

  it("keeps the error byte-identical while a surviving unregistered tip is unattributed, and says it once", async () => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "work with no stamp");
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const task = parkedTask(f.pinnedPath);
    const errorBefore = task.error;
    const { updates, audit, manager } = harness(task, f.repoDir);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);
    // A second maintenance pass at the churn cadence must not re-announce the same refusal.
    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(task.error).toBe(errorBefore);
    const refused = rowsOf(audit, NO_ACTION);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.metadata).toMatchObject({ code: "foreign-unmerged", outcome: "no-action" });
  });

  it("announces a NEW refusal reason for the same card instead of swallowing it behind the dedupe", async () => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, "feat(RUFU-999): foreign work", "Fusion-Task-Id: RUFU-999");

    const task = parkedTask(f.pinnedPath);
    const { audit, manager } = harness(task, f.repoDir);
    // Pass 1: the branch is still checked out, so the refusal is the live checkout.
    await manager.reconcileStaleAcquisitionConflicts();
    expect(rowsOf(audit, NO_ACTION)).toHaveLength(1);
    expect(rowsOf(audit, NO_ACTION).at(-1)!.metadata).toMatchObject({ code: "live-registration" });

    // Pass 2: the checkout is gone but the foreign work survives, so the refusal is now RUFU-292's
    // preservation boundary — a different reason, and suppressing it would hide the remedy change.
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });
    await manager.reconcileStaleAcquisitionConflicts();

    const codes = rowsOf(audit, NO_ACTION).map((row) => (row.metadata as Record<string, unknown>).code);
    expect(codes).toEqual(["live-registration", "foreign-unmerged"]);
  });

  it("never clears on an unreadable repository: an inspection that did not run is not proof of absence", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "rufu-356-sweep-notrepo-"));
    repos.push(notARepo);

    const task = parkedTask(join(notARepo, ".fusion", "worktrees", TASK_ID.toLowerCase()));
    const errorBefore = task.error;
    const { updates, audit, manager } = harness(task, notARepo);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(task.error).toBe(errorBefore);
    expect(rowsOf(audit, NO_ACTION).at(-1)!.metadata).toMatchObject({ code: "probe-unknown" });
  });

  it("does not consider a card whose error is not the retry-cap envelope", async () => {
    const f = trackedFixture();
    const neighbours = [
      // The base-diverged park: different premise, operator-only remedy.
      "TASK_BASE_DIVERGED: local main has diverged from origin/main (2 ahead / 3 behind). Reconcile manually.",
      // The review-lane sentence: another lane's remedy.
      "Worktree acquisition failed before the review produced a verdict. Retry the task to re-run implementation.",
      // The executor's create-failure wording: the WIP lane owns it.
      "Failed to create worktree after 2 attempts: Branch \"fusion/x\" is already checked out",
      // The inner conflict sentence on its own — the wording RUFU-376 already reworded once.
      `Branch ${BRANCH} is already checked out at ${f.pinnedPath}`,
    ];

    for (const error of neighbours) {
      const task = parkedTask(f, { error });
      const { updates, audit, manager } = harness(task, f.repoDir);
      await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);
      expect(updates).toEqual([]);
      expect(audit).toEqual([]);
    }
  });

  it("refuses a card the park did not leave in its own rebound lane, without touching it", async () => {
    const f = trackedFixture();
    const task = parkedTask(f, { column: "wip" });
    const errorBefore = task.error;
    const { updates, moves, audit, manager } = harness(task, f.repoDir);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(moves).toEqual([]);
    expect(task.error).toBe(errorBefore);
    expect(rowsOf(audit, NO_ACTION).at(-1)!.metadata).toMatchObject({ code: "wrong-lane", outcome: "no-action" });
  });

  it("never reaches through an operator pause", async () => {
    const f = trackedFixture();
    const task = parkedTask(f, { userPaused: true });
    const errorBefore = task.error;
    const { updates, audit, manager } = harness(task, f.repoDir);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(task.error).toBe(errorBefore);
    expect(rowsOf(audit, NO_ACTION).at(-1)!.metadata).toMatchObject({ code: "paused" });
  });

  it("leaves a workspace card alone: one root probe cannot speak for several repositories", async () => {
    const f = trackedFixture();
    const task = parkedTask(f, { workspaceWorktrees: { "packages/a": { path: "packages/a", branch: BRANCH } } });
    const errorBefore = task.error;
    const { updates, audit, manager } = harness(task, f.repoDir);

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(task.error).toBe(errorBefore);
    expect(rowsOf(audit, NO_ACTION).at(-1)!.metadata).toMatchObject({ code: "workspace-task" });
  });

  it("skips a card a live session owns right now, and records nothing for the race", async () => {
    const f = trackedFixture();
    const task = parkedTask(f);
    const { updates, audit, manager } = harness(task, f.repoDir, { executingIds: new Set([TASK_ID]) });

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);

    expect(updates).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("writes and announces nothing while the engine is paused", async () => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, `feat(${TASK_ID}): own work`, `Fusion-Task-Id: ${TASK_ID}`);
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const task = parkedTask(f);
    const { updates, audit, manager } = harness(task, f.repoDir, { settings: { globalPause: true } });

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);
    expect(updates).toEqual([]);
    expect(audit).toEqual([]);
  });

  it.each([
    ["absent", "absent"],
    ["throwing", "throwing"],
    ["rejecting", "rejecting"],
    ["hanging", "hanging"],
  ] as const)("releases the card anyway when the audit sink is %s (FN-9175)", async (_label, sink) => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, `feat(${TASK_ID}): own work`, `Fusion-Task-Id: ${TASK_ID}`);
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const task = parkedTask(f);
    const { updates, manager } = harness(task, f.repoDir, { sink });

    await expect(manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(1);
    expect(updates).toEqual([{ status: null, error: null }]);
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
  });

  it("re-derives admission against the live row and keeps a drifted card's state", async () => {
    const f = trackedFixture();
    registerCardWorktree(f);
    commitIn(f.pinnedPath, `feat(${TASK_ID}): own work`, `Fusion-Task-Id: ${TASK_ID}`);
    rmSync(f.pinnedPath, { recursive: true, force: true });
    rmSync(f.adminDir, { recursive: true, force: true });

    const task = parkedTask(f);
    // The card was retried by its operator between the page read and the fenced write.
    const h = harness(task, f.repoDir, { driftBeforeWrite: (live) => { live.status = null; live.error = null; } });

    await expect(h.manager.reconcileStaleAcquisitionConflicts()).resolves.toBe(0);
    // Drift is reported as the honest pair: the probe cleared, the write did not.
    expect(rowsOf(h.audit, NO_ACTION).at(-1)!.metadata).toMatchObject({ code: "premise-cleared", outcome: "no-action" });
    expect(rowsOf(h.audit, CLEARED)).toEqual([]);
    expect(h.updates).toEqual([]);
  });
});

/*
 * Structural guard, not a prose assertion: the maintenance wrapper must read the cycle's PRE-CAPTURED
 * churn flag. `runMaintenance()` advances `lastGitWorktreeChurnAt` before batch 1 runs, so a step that
 * re-queried `isGitWorktreeChurnDue()` inside its own body would read `false` on every pass and
 * silently never run — a fact no behavioral test can observe from outside the maintenance loop.
 */
describe("maintenance registration (RUFU-356)", () => {
  const SELF_HEALING_SOURCE = fileURLToPath(new URL("../self-healing.ts", import.meta.url));
  /** Strips block/line comments so the scan can only ever match shipped code, never an FNXC note. */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  it("runs the sweep at the pre-captured git-churn cadence and never inside a paused cycle", () => {
    const source = codeOnly(readFileSync(SELF_HEALING_SOURCE, "utf8"));
    expect(
      source.includes(
        'name: "reconcile-stale-acquisition-conflicts",\n          fn: () => (maintenancePaused || !gitWorktreeChurnDue ? Promise.resolve(0) : this.reconcileStaleAcquisitionConflicts()),',
      ),
    ).toBe(true);
  });

  it("registers the sweep as a startup recovery step too, so a restart cannot leave a stale park", () => {
    const source = codeOnly(readFileSync(SELF_HEALING_SOURCE, "utf8"));
    expect(source.includes('{ name: "reconcile-stale-acquisition-conflicts", fn: () => this.reconcileStaleAcquisitionConflicts().then(() => undefined) }')).toBe(true);
  });

  it("resolves its sweep source from this test file's own location, not the runner's cwd", () => {
    // The scan above must keep pointing at the engine's self-healing manager if this file or that one
    // moves; a cwd-relative path would silently scan the wrong file and pass.
    expect(existsSync(SELF_HEALING_SOURCE)).toBe(true);
    expect(SELF_HEALING_SOURCE.endsWith(join("packages", "engine", "src", "self-healing.ts"))).toBe(true);
  });
});
