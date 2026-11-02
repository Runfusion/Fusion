/**
 * FNXC:TerminalBranchConflictPark 2026-11-02-15:11 (RUFU-439):
 * PG + real-git regression for `reconcileTerminalBranchConflictParks` — the relief valve for a card
 * that carried `paused=true` + `pausedReason=branch-conflict-unrecoverable` into a TERMINAL lane.
 *
 * The defect being recovered was structural, not slow: `reclaimSelfOwnedBranchConflicts` — the only
 * automated owner of this park — builds candidates from `hold` / `countsTowardWip` / `REVIEW_ROLES`
 * and never reads a `complete`-role column, so a card parked in `done` had no automated claimant on
 * boot or on any maintenance pass. Six real cards sat there ~23.4 days on a premise git no longer
 * agrees exists (measured: ref absent, no registered worktree, `git worktree prune -n -v` silent).
 *
 * The invariant this file holds, rather than the single reported batch:
 * 1. A terminal card wearing this badge is cleared ONLY when the premise is re-proved dead from real
 *    git — branch ref absent AND no registered worktree — and the clear is IN PLACE (`column` asserted
 *    unchanged, because lifecycle containment is the whole point: `done` stays terminal).
 * 2. A live premise is never cleared. A real registered worktree is the honest shape of that case: in
 *    real git a branch checked out in a worktree implies its ref exists too, so this pins the
 *    observable ("a live checkout survives") rather than a synthetic arm no repository can produce.
 * 3. An operator `userPaused` survives, a DIFFERENT `pausedReason` is untouched, and a card in a
 *    NON-terminal lane is untouched — `reclaimSelfOwnedBranchConflicts` remains that lane's owner.
 * 4. Worktree-inventory matching is EXACT, never prefix: decoy branches/worktrees whose names start
 *    with the card's branch name must not be read as a live premise, and must not be read as absence
 *    proof either — the inventory read succeeds and is populated.
 * 5. A workspace card HOLDS: both probes read `options.rootDir` only, so for a member-repository
 *    branch `absent` at the root would be an absence of looking, not absence of the branch.
 * 6. The audit payload is the closed ids/enums set — four keys, no auditor envelope — and no value
 *    carries the branch name or the park's error sentence.
 *
 * Both halves of the symptom contract live here: the automated fixture (this file) and the live-board
 * re-read of the six real cards, recorded in the task's `park-audit` document. Green tests alone are
 * not the whole acceptance evidence for a stale-badge bug.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

const pgTest = pgDescribe;

const PARK_EVENT = "task:reconcile-terminal-branch-conflict-park";
const PARK_REASON = "branch-conflict-unrecoverable";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

interface RepoFixture {
  rootDir: string;
  cleanup: () => void;
}

const openFixtures: Array<() => void> = [];

/**
 * A REAL git repository as the sweep's `rootDir`, with no trace of the card's branch — the dead
 * premise. Fixtures are real because the sweep's whole contract is "absence proven from full git
 * output"; a mocked git would let a broken parser pass.
 */
function createRepoFixture(label: string): RepoFixture {
  if (!hasGit) throw new Error("git is required for this fixture");
  const base = mkdtempSync(join(tmpdir(), `term-bcp-${label}-`));
  const rootDir = join(base, "repo");
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "card@example.com"');
  git(rootDir, 'git config user.name "Card User"');
  writeFileSync(join(rootDir, "tracked.txt"), "base\n", "utf8");
  git(rootDir, "git add tracked.txt");
  git(rootDir, "git commit -m 'chore: base'");
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  openFixtures.push(cleanup);
  return { rootDir, cleanup };
}

pgTest("self-healing reconcileTerminalBranchConflictParks (PostgreSQL + real git, RUFU-439)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_term_bcp",
    projectId: "rufu439-sweep",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);
  afterEach(() => {
    while (openFixtures.length > 0) openFixtures.pop()!();
  });

  /**
   * Seed a card wearing the exact live park shape, in the caller's lane. The pause pair goes through
   * `adminSql` because `updateTask` runs pause ACCOUNTING on the seam (the bank this sweep must later
   * consume), and the fixture has to write a pre-existing pause with its own `paused_started_at` — the
   * same seeding the reviewed non-convergence PG test uses for the identical reason.
   */
  async function seedParked(
    id: string,
    shape: {
      column?: string;
      pausedReason?: string;
      userPaused?: boolean;
      /** `null` reproduces the `status=None` variant the real RUFU-047 carried. */
      status?: string | null;
      /** Pass `null` to reproduce a row whose branch field was cleared. */
      branch?: string | null;
      workspace?: boolean;
    } = {},
  ): Promise<string> {
    const store = h.store();
    const column = shape.column ?? "done";
    await store.createTaskWithReservedId(
      { description: id, column },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    const branch = shape.branch === null ? null : (shape.branch ?? `fusion/${id.toLowerCase()}`);
    await store.updateTask(id, {
      status: (shape.status === undefined ? "failed" : shape.status) as never,
      error: `Task branch conflict: ${branch ?? "fusion/none"} is not safely reclaimable (Branch ${branch ?? "fusion/none"} is already checked out at .worktrees/${id.toLowerCase()})` as never,
      ...(shape.workspace ? { workspaceWorktrees: { "members/a": { worktreePath: "/nonexistent/members/a", branch: branch ?? "main" } } } as never : {}),
    });
    await h.adminSql()`UPDATE project.tasks SET paused = 1, paused_reason = ${shape.pausedReason ?? PARK_REASON}, paused_started_at = '2026-01-01T00:00:00.000Z' WHERE id = ${id}`;
    if (shape.userPaused) {
      await h.adminSql()`UPDATE project.tasks SET user_paused = 1 WHERE id = ${id}`;
    }
    store.taskCache.delete(id);
    return id;
  }

  async function auditRows(taskId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await h.adminSql()`SELECT metadata FROM project.run_audit_events WHERE task_id = ${taskId} AND mutation_type = ${PARK_EVENT}`;
    return rows.map((row: { metadata: unknown }) =>
      (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>);
  }

  it("clears a terminal park whose premise is dead, IN PLACE, with audit + history", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("clear");
    const id = await seedParked("rufu439-a1", { status: "failed" });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(1);

    const repaired = await store.getTask(id);
    // The four fields land in the cleared shape TOGETHER — no half-cleared residue.
    /*
    `paused` is asserted by TRUTHINESS, not `=== false`: the row mapper returns a cleared boolean as
    `undefined` rather than `false`, and every badge consumer (the dashboard row, the CLI's
    "Status: PAUSED" line) reads it that way too. Asserting literal `false` would pin a mapper artifact
    instead of the invariant "this card no longer wears a pause".
    */
    expect(Boolean(repaired?.paused)).toBe(false);
    expect(repaired?.pausedReason ?? undefined).toBeUndefined();
    expect(repaired?.status ?? undefined).toBeUndefined();
    expect(repaired?.error ?? undefined).toBeUndefined();
    // LIFECYCLE CONTAINMENT: the deliverable is the badge's disposition, never a relocation.
    expect(repaired?.column).toBe("done");
    // The pause is banked, not erased — the elapsed pause must survive into cumulative time.
    expect(typeof repaired?.cumulativePausedMs).toBe("number");
    expect(repaired?.pausedStartedAt ?? undefined).toBeUndefined();
    expect((repaired?.log ?? []).some((entry) => /stale branch-conflict park/i.test(entry.action))).toBe(true);

    const rows = await auditRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      taskId: id,
      column: "done",
      priorStatus: "failed",
      outcome: "stale-park-cleared",
    });
  });

  it("never clears a park whose branch ref still exists (live premise)", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("live-ref");
    const id = await seedParked("rufu439-a2");
    // The premise comes alive: the branch the park names exists in the repository git just consulted.
    git(rootDir, `git branch fusion/${id.toLowerCase()} main`);

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.paused).toBe(true);
    expect(kept?.pausedReason).toBe(PARK_REASON);
    expect(kept?.status).toBe("failed");
    expect(kept?.column).toBe("done");
    expect((await auditRows(id)).length).toBe(0);
  });

  it("never clears a park whose branch is checked out in a registered worktree", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("live-worktree");
    const id = await seedParked("rufu439-a3");
    const worktreePath = join(rootDir, "..", "worktrees", id.toLowerCase());
    git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} -b fusion/${id.toLowerCase()} main`);
    // Prove the registration is really in the inventory the sweep parses (FULL output, not a count).
    expect(git(rootDir, "git worktree list --porcelain")).toContain(`branch refs/heads/fusion/${id.toLowerCase()}`);

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.paused).toBe(true);
    expect(kept?.pausedReason).toBe(PARK_REASON);
    expect((await auditRows(id)).length).toBe(0);
  });

  it("never reaches through an operator user-pause, even with a dead premise", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("user-paused");
    const id = await seedParked("rufu439-a4", { userPaused: true });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.paused).toBe(true);
    expect(kept?.pausedReason).toBe(PARK_REASON);
    expect((await auditRows(id)).length).toBe(0);
  });

  it("leaves a badge owned by a different pausedReason completely untouched", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("other-reason");
    const id = await seedParked("rufu439-a5", { pausedReason: "in-review-stall-deadlock" });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.paused).toBe(true);
    expect(kept?.pausedReason).toBe("in-review-stall-deadlock");
    expect(kept?.status).toBe("failed");
  });

  it("does not touch the same badge in a NON-terminal lane — reclaim owns that lane", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("non-terminal");
    // Identical badge + an equally dead premise, but in the review lane. The clearing here would be a
    // second owner for `reclaimSelfOwnedBranchConflicts`' row, which is exactly the split-brain this
    // sweep's lane boundary exists to prevent.
    const id = await seedParked("rufu439-a6", { column: "in-review" });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.paused).toBe(true);
    expect(kept?.pausedReason).toBe(PARK_REASON);
    expect((await auditRows(id)).length).toBe(0);
  });

  it("is idempotent — a second pass clears nothing", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("twice");
    const id = await seedParked("rufu439-a7");

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(1);
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);
    // Exactly one audit row: the disposition is recorded once per card, not once per pass.
    expect((await auditRows(id)).length).toBe(1);
  });

  it("clears the status=None variant the real RUFU-047 carried, identically", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("status-none");
    const id = await seedParked("rufu439-a8", { status: null });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(1);

    const repaired = await store.getTask(id);
    expect(Boolean(repaired?.paused)).toBe(false);
    expect(repaired?.column).toBe("done");
    const rows = await auditRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0].priorStatus).toBeNull();
  });

  it("derives fusion/<id> and clears when the row's branch field is gone", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("no-branch");
    const id = await seedParked("rufu439-a9", { branch: null });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(1);
    expect(Boolean((await store.getTask(id))?.paused)).toBe(false);
  });

  it("holds a workspace card: rootDir probes cannot see a member-repository branch", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("workspace");
    const id = await seedParked("rufu439-a10", { workspace: true });

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(0);

    const kept = await store.getTask(id);
    expect(kept?.paused).toBe(true);
    expect(kept?.pausedReason).toBe(PARK_REASON);
  });

  it("matches worktree registrations EXACTLY — prefix-similar decoys are neither premise nor absence", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("exact-match");
    const id = "rufu439-a11";
    const wanted = `fusion/${id}`;
    await seedParked(id);
    // Decoys whose names START with the card's branch: a prefix match would read these as a live
    // premise and the card would keep its undead badge forever.
    git(rootDir, `git branch ${JSON.stringify(`${wanted}-x`)} main`);
    git(rootDir, `git branch ${JSON.stringify(`${wanted}2`)} main`);
    const decoyWorktree = join(rootDir, "..", "worktrees", "decoy");
    // The decoy branch exists from the line above, so this CHECKS IT OUT; asking git to create it
    // again with `-b` is a duplicate-branch refusal, not a fixture of a live checkout.
    git(rootDir, `git worktree add ${JSON.stringify(decoyWorktree)} ${JSON.stringify(`${wanted}-x`)}`);
    // The inventory the sweep parses is populated and readable — the `absent` verdict below is earned
    // against a real non-empty listing, not against an empty one.
    const inventory = git(rootDir, "git worktree list --porcelain");
    expect(inventory).toContain(`branch refs/heads/${wanted}-x`);
    expect(inventory).not.toContain(`branch refs/heads/${wanted}\n`);
    // Full-output absence proof for the ref itself (a `git branch --list` of the exact name prints nothing).
    expect(git(rootDir, `git branch --list ${JSON.stringify(wanted)}`)).toBe("");

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(1);
    expect(Boolean((await store.getTask(id))?.paused)).toBe(false);
  });

  it("records no branch name, worktree path, or park sentence in the audit payload", async () => {
    const store = h.store();
    const { rootDir } = createRepoFixture("payload");
    const id = await seedParked("rufu439-a12");

    const manager = new SelfHealingManager(store, { rootDir });
    expect(await manager.reconcileTerminalBranchConflictParks()).toBe(1);

    const rows = await auditRows(id);
    expect(rows.length).toBe(1);
    const meta = rows[0];
    /*
    The closed set, asserted as an EXACT key list: `emitBoundedRunAudit` is used instead of
    `createRunAuditor` precisely so the stored jsonb carries no `phase`/`source`/`taskLineageId`
    envelope, so this assertion is the pair invariant's metadata contract and a key the docs do not
    declare must fail loudly here.
    */
    expect(Object.keys(meta).sort()).toEqual(["column", "outcome", "priorStatus", "taskId"]);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(`fusion/${id.toLowerCase()}`);
    expect(serialized).not.toContain(".worktrees/");
    expect(serialized).not.toContain("not safely reclaimable");
    expect(serialized).not.toContain(PARK_REASON);
  });
});
