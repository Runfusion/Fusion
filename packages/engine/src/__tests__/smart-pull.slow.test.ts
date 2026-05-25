import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { smartPull, type SmartPullAuditEvent } from "../smart-pull.js";

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf-8").trim();
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

interface Fixture {
  root: string;
  upstream: string;
  cloneA: string; // simulates the user's main checkout
  cloneB: string; // simulates the merger's task worktree side (used only to push)
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(testTempParent(), "smart-pull-"));
  const upstream = join(root, "upstream.git");
  const cloneA = join(root, "userMain");
  const cloneB = join(root, "merger");

  git(root, `git init --bare -b main "${upstream}"`);
  git(root, `git clone "${upstream}" "${cloneA}"`);
  git(cloneA, 'git config user.email "user@example.com"');
  git(cloneA, 'git config user.name "User"');
  writeFileSync(join(cloneA, "shared.txt"), "v1\n");
  git(cloneA, "git add shared.txt");
  git(cloneA, 'git commit -m "init"');
  git(cloneA, "git push -u origin main");

  git(root, `git clone "${upstream}" "${cloneB}"`);
  git(cloneB, 'git config user.email "merger@example.com"');
  git(cloneB, 'git config user.name "Merger"');

  return { root, upstream, cloneA, cloneB };
}

function advanceUpstream(fx: Fixture, content: string, message: string): void {
  writeFileSync(join(fx.cloneB, "shared.txt"), content);
  git(fx.cloneB, "git add shared.txt");
  git(fx.cloneB, `git commit -m "${message}"`);
  git(fx.cloneB, "git push origin main");
}

describe("smartPull", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });
  afterEach(() => {
    try {
      rmSync(fx.root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("clean-pull: fast-forwards a clean worktree and emits pull:fast-forward", async () => {
    advanceUpstream(fx, "v2\n", "advance");
    const before = git(fx.cloneA, "git rev-parse HEAD");

    const events: SmartPullAuditEvent[] = [];
    const result = await smartPull({
      worktreePath: fx.cloneA,
      integrationBranch: "main",
      mode: "stash-and-ff",
      taskId: "FN-TEST-1",
      emit: (e) => { events.push(e); },
    });

    expect(result.kind).toBe("clean-pull");
    const after = git(fx.cloneA, "git rev-parse HEAD");
    expect(after).not.toBe(before);
    if (result.kind === "clean-pull") {
      expect(result.fromSha).toBe(before);
      expect(result.toSha).toBe(after);
    }
    expect(events.map((e) => e.mutationType)).toEqual(["pull:fast-forward"]);
    expect(events[0].metadata).toMatchObject({ taskId: "FN-TEST-1", succeeded: true });
  });

  it("stash-pull-pop: stashes dirty edits, fast-forwards, and restores them", async () => {
    advanceUpstream(fx, "v2\n", "advance");
    writeFileSync(join(fx.cloneA, "local.txt"), "local edit\n");
    writeFileSync(join(fx.cloneA, "shared.txt"), "v1\nlocal mod\n");
    git(fx.cloneA, "git add -A");
    const before = git(fx.cloneA, "git rev-parse HEAD");

    const events: SmartPullAuditEvent[] = [];
    const result = await smartPull({
      worktreePath: fx.cloneA,
      integrationBranch: "main",
      mode: "stash-and-ff",
      taskId: "FN-TEST-2",
      emit: (e) => { events.push(e); },
    });

    // Either stash-pull-pop (clean restore) or stash-pop-conflict if shared.txt collides
    expect(["stash-pull-pop", "stash-pop-conflict"]).toContain(result.kind);
    const after = git(fx.cloneA, "git rev-parse HEAD");
    expect(after).not.toBe(before);
    const status = git(fx.cloneA, "git status --porcelain=v1");
    // local.txt is the unambiguous local edit; it must survive either way
    expect(status).toContain("local.txt");
    // pull:fast-forward should fire (succeeded), stash:push should fire, and
    // either stash:pop or stash:pop-conflict closes the sequence.
    const types = events.map((e) => e.mutationType);
    expect(types).toContain("stash:push");
    expect(types).toContain("pull:fast-forward");
    expect(types.some((t) => t === "stash:pop" || t === "stash:pop-conflict")).toBe(true);
  });

  it("ff-only: skips dirty worktree and reports reason without modifying HEAD", async () => {
    advanceUpstream(fx, "v2\n", "advance");
    writeFileSync(join(fx.cloneA, "local.txt"), "local edit\n");
    const before = git(fx.cloneA, "git rev-parse HEAD");

    const events: SmartPullAuditEvent[] = [];
    const result = await smartPull({
      worktreePath: fx.cloneA,
      integrationBranch: "main",
      mode: "ff-only",
      emit: (e) => { events.push(e); },
    });

    expect(result.kind).toBe("skipped-dirty");
    if (result.kind === "skipped-dirty") {
      expect(result.reason).toBe("ff-only-mode-requires-clean-tree");
      expect(result.fromSha).toBe(before);
    }
    expect(git(fx.cloneA, "git rev-parse HEAD")).toBe(before);
    expect(events).toHaveLength(0);
  });

  it("skipped-not-on-branch: returns current branch when checkout is elsewhere", async () => {
    git(fx.cloneA, "git checkout -b feature");
    const result = await smartPull({
      worktreePath: fx.cloneA,
      integrationBranch: "main",
      mode: "stash-and-ff",
    });
    expect(result.kind).toBe("skipped-not-on-branch");
    if (result.kind === "skipped-not-on-branch") {
      expect(result.currentBranch).toBe("feature");
    }
  });

  it("audit emitter exceptions never break the pull pipeline", async () => {
    advanceUpstream(fx, "v2\n", "advance");
    const result = await smartPull({
      worktreePath: fx.cloneA,
      integrationBranch: "main",
      mode: "stash-and-ff",
      emit: () => { throw new Error("audit store offline"); },
    });
    expect(result.kind).toBe("clean-pull");
  });
});

