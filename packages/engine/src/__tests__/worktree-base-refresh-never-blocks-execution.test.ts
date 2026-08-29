/*
FNXC:WorktreeBaseRefresh 2026-08-09-23:49 (a stale base is never an execution failure — regression):

Reported symptom: Fusion paged the operator with "**<task> needs operator action** — The task entered a terminal
failed state" many times a day, rising to 17 on 2026-08-09. Run-audit over 2026-08-01..09 showed 99 of 136
execution failures were pre-session worktree base-refresh refusals (74 `dirty-worktree`, 25
`stale-base-conflict`), and 82 of them landed within five minutes of "Task marked done by agent" — they were
code-review-remediation re-entries into `execute()` on the task's OWN warm worktree. The refusal threw
`WorktreeBaseRefreshError` out of `acquireTaskWorktree`, and the `execute()` call site had no catch, so it fell
through every classifier to the generic terminal sink and parked the task `failed`. The bounded non-parking lane
built for exactly this fired 0 times, because it only ever saw refusals published as typed graph node values and
no code node enables `refreshStaleBase`.

Invariant under test, across every refusal shape observed in production: refreshing the base is an optimization,
so a refresh that cannot proceed DECLINES and lets the session run on the existing base — it never blocks
execution and never destroys the agent's uncommitted work. The merge lane still rebases with conflict
resolution before landing, which is why dispatch-time rebase (which has no conflict resolution) must not be
authoritative. Only an UNPROVEN tree — compensation failed, so a half-rebased checkout may be on disk — may
still refuse, because handing an agent that checkout would corrupt real work.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree, WorktreeBaseRefreshError } from "../worktree/worktree-acquisition.js";
import { refreshReusedWorktreeBase } from "../worktree-base-refresh.js";

const paths: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/**
 * A task planned at C0 on its own branch while the integration branch advanced to C1 — the shape every
 * production refusal had.
 */
function reusedWorktree() {
  const root = mkdtempSync(join(tmpdir(), "fn-base-refresh-"));
  paths.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "shared.ts"), "export const shared = 'main-C0';\n");
  git(root, ["add", "shared.ts"]);
  git(root, ["commit", "-m", "C0"]);
  const c0 = git(root, ["rev-parse", "HEAD"]);

  const worktree = join(root, "linked");
  git(root, ["worktree", "add", "-b", "fusion/fn-1", worktree, c0]);

  // Integration advances under the task.
  writeFileSync(join(root, "shared.ts"), "export const shared = 'main-C1';\n");
  git(root, ["add", "shared.ts"]);
  git(root, ["commit", "-m", "C1"]);

  return { root, worktree, c0, c1: git(root, ["rev-parse", "HEAD"]) };
}

function acquire(root: string, worktree: string, baseCommitSha: string) {
  const store = { updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) } as any;
  const promise = acquireTaskWorktree({
    task: { id: "FN-1", title: "reuse", description: "", branch: "fusion/fn-1", worktree, baseCommitSha } as any,
    rootDir: root,
    store,
    settings: {} as any,
    refreshStaleBase: true,
    createWorktree: vi.fn(),
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  return { store, promise };
}

describe("worktree base refresh never blocks execution", () => {
  it("proceeds with uncommitted agent work intact instead of refusing (the 74 dirty-worktree parks)", async () => {
    const { root, worktree, c0 } = reusedWorktree();
    // The remediation re-entry shape: the previous session left edits in the task's own warm checkout.
    writeFileSync(join(worktree, "in-flight.ts"), "export const inFlight = true;\n");

    const { store, promise } = acquire(root, worktree, c0);
    await expect(promise).resolves.toMatchObject({
      source: "existing",
      baseRefresh: { kind: "dirty-worktree", executionSafe: true, skipped: true },
    });

    // The work the agent is mid-way through must survive untouched, on its original base.
    expect(readFileSync(join(worktree, "in-flight.ts"), "utf8")).toBe("export const inFlight = true;\n");
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(c0);
    // Operators still see WHY the base is stale — as a skip, not an execution failure.
    const logged = store.logEntry.mock.calls.map(([, message]: [string, string]) => message).join("\n");
    expect(logged).toContain("Worktree base refresh skipped (dirty-worktree)");
    expect(logged).not.toContain("blocked execution");
  });

  it("keeps the local base when the task's own commits conflict with the moved base (the 25 stale-base-conflict parks)", async () => {
    const { root, worktree, c0, c1 } = reusedWorktree();
    // Task commits C2 touching the same file main advanced → rebase onto C1 must conflict.
    writeFileSync(join(worktree, "shared.ts"), "export const shared = 'task-C2';\n");
    git(worktree, ["add", "shared.ts"]);
    git(worktree, ["commit", "-m", "C2"]);
    const c2 = git(worktree, ["rev-parse", "HEAD"]);

    const { promise } = acquire(root, worktree, c0);
    await expect(promise).resolves.toMatchObject({
      source: "existing",
      baseRefresh: { kind: "stale-base-conflict", executionSafe: true, skipped: true },
    });

    // Compensated back to the task's own tip: no rebase in progress, no conflict markers, no lost commit.
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(c2);
    expect(git(worktree, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(worktree, "shared.ts"), "utf8")).toBe("export const shared = 'task-C2';\n");
    expect(c2).not.toBe(c1);
  });

  it("still advances a clean worktree with no own commits — the optimization is preserved, not disabled", async () => {
    const { root, worktree, c0, c1 } = reusedWorktree();

    const { store, promise } = acquire(root, worktree, c0);
    await expect(promise).resolves.toMatchObject({
      baseRefresh: { kind: "reset-to-base", executionSafe: true },
    });

    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(c1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { baseCommitSha: c1 });
  });

  /*
  The residual blocking case. It must remain reachable: an unproven tree is the one state where running a
  session really would corrupt work, and the executor routes this throw into the bounded non-parking hold
  rather than the terminal sink.
  */
  it("still refuses execution when compensation cannot prove the tree was restored", async () => {
    const { root, worktree, c0 } = reusedWorktree();

    // A clean advance reaches the baseline write; failing it AND destroying the checkout in the same step makes
    // the restore unprovable, which is the only state that may still refuse a session.
    const store = {
      updateTask: vi.fn().mockImplementation(async () => {
        rmSync(worktree, { recursive: true, force: true });
        throw new Error("database unavailable");
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any,
      rootDir: root,
      worktreePath: worktree,
      store,
      settings: {},
    });

    expect(result).toMatchObject({ kind: "base-reconciliation-required", executionSafe: false });
    expect(result.skipped).toBeFalsy();
  });

  it("carries the refusal kind on the thrown error so the executor can hold rather than park", async () => {
    const error = new WorktreeBaseRefreshError({ kind: "base-reconciliation-required", executionSafe: false });
    expect(error).toBeInstanceOf(Error);
    expect(error.refresh.kind).toBe("base-reconciliation-required");
  });
});
