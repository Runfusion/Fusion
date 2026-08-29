import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { __test__ } from "../merger.js";

const { listAutostashOrphans, applyAutostashBySha, getAutostashDiff, notifyAutostashOrphans } = __test__;

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf-8").trim();
}

function initRepo(dir: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, "git add file.txt");
  git(dir, 'git commit -m "init"');
}

function createAutostash(dir: string, label: string, content: string): string {
  writeFileSync(join(dir, "file.txt"), content);
  git(dir, "git add file.txt");
  const sha = git(dir, "git stash create");
  git(dir, `git stash store -m ${JSON.stringify(label)} ${sha}`);
  git(dir, "git reset --hard HEAD");

  const list = git(dir, 'git stash list --format="%H %gd %s"');
  if (!list.includes(label)) {
    git(dir, "git stash drop stash@{0}");
    writeFileSync(join(dir, "file.txt"), content);
    git(dir, `git stash push -m ${JSON.stringify(label)} file.txt`);
    return git(dir, 'git stash list --format="%H" -n 1');
  }

  return sha;
}

function testTempParent(): string {
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertIsolatedWorkspace(dir: string): void {
  const repoRoot = process.env.FUSION_TEST_REAL_ROOT;
  if (!repoRoot) return;
  expect(resolve(dir).startsWith(resolve(repoRoot))).toBe(false);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupTempDir(dir?: string): void {
  if (!dir) return;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      if (!existsSync(dir)) return;
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return;
    } catch (error) {
      if (attempt === 5) {
        throw error;
      }
    }

    sleepSync(attempt * 25);
  }

  if (existsSync(dir)) {
    throw new Error(`failed to clean temp dir: ${dir}`);
  }
}

// FN-4807: keep this real-git stash suite bounded but above Vitest's default
// to avoid workspace-contention false timeouts without weakening subprocess guards.
describe("autostash orphan surface", { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(testTempParent(), "fusion-test-merger-autostash-surface-"));
    assertIsolatedWorkspace(dir);
    initRepo(dir);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("lists fusion-merger-autostash entries and ignores unrelated stashes", async () => {
    const ts = Date.now();
    createAutostash(dir, `fusion-merger-autostash:FN-2001:${ts}`, "feature\n");
    writeFileSync(join(dir, "file.txt"), "manual\n");
    git(dir, 'git stash push -m "manual" file.txt');

    const records = await listAutostashOrphans(dir);

    expect(records).toHaveLength(1);
    expect(records[0]?.label).toContain("fusion-merger-autostash:FN-2001");
  });

  it("parses sourceTaskId, createdAt, and source phase; malformed labels return null fields", async () => {
    const ts = Date.now();
    createAutostash(dir, `fusion-merger-autostash:FN-2002:${ts}`, "a\n");
    createAutostash(dir, `fusion-merger-autostash:FN-2002:finalize-reset:${ts + 1}`, "phase\n");
    createAutostash(dir, "fusion-merger-autostash:FN-2003:not-a-ts", "b\n");

    const records = await listAutostashOrphans(dir);
    const good = records.find((r) => r.sourceTaskId === "FN-2002" && r.sourcePhase === "pre-merge");
    const bad = records.find((r) => r.label.includes("not-a-ts"));

    const phased = records.find((r) => r.label.includes("finalize-reset"));
    expect(good?.createdAt).toBe(new Date(ts).toISOString());
    expect(phased?.sourcePhase).toBe("finalize-reset");
    expect(bad?.sourceTaskId).toBe("FN-2003");
    expect(bad?.createdAt).toBeNull();
  });

  it("classifies subsumed vs live from diff against HEAD", async () => {
    const subsumedSha = createAutostash(dir, `fusion-merger-autostash:FN-2004:${Date.now()}`, "subsumed\n");
    writeFileSync(join(dir, "file.txt"), "subsumed\n");
    git(dir, "git add file.txt");
    git(dir, 'git commit -m "subsumed"');

    const liveSha = createAutostash(dir, `fusion-merger-autostash:FN-2005:${Date.now()}`, "live\n");

    const records = await listAutostashOrphans(dir);

    expect(records.find((r) => r.sha === subsumedSha)?.classification).toBe("subsumed");
    expect(records.find((r) => r.sha === liveSha)?.classification).toBe("live");
  });

  it("applies stash on clean tree and reports conflict without dropping stash", async () => {
    const label = `fusion-merger-autostash:FN-2006:${Date.now()}`;
    const sha = createAutostash(dir, label, "from-stash\n");

    const applyOk = await applyAutostashBySha(dir, sha);
    expect(applyOk).toEqual({ ok: true });
    expect(git(dir, "cat file.txt")).toContain("from-stash");

    git(dir, "git checkout -- file.txt");
    writeFileSync(join(dir, "file.txt"), "other-change\n");
    git(dir, "git add file.txt");
    git(dir, 'git commit -m "conflicting commit"');

    const conflict = await applyAutostashBySha(dir, sha);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe("conflict");
      expect(conflict.stderr).toBeTruthy();
    }

    expect(git(dir, 'git stash list --format="%H %s"')).toContain(sha);
  });

  it("emits merger:autostashOrphans event with provenance payload", async () => {
    createAutostash(dir, `fusion-merger-autostash:FN-2008:${Date.now()}`, "emit\n");
    const store = { emit: vi.fn() } as any;

    const records = await notifyAutostashOrphans(store, dir, { detectedByTaskId: "FN-MERGE" });

    expect(records[0]?.detectedByTaskId).toBe("FN-MERGE");
    expect(records[0]?.detectedAt).toMatch(/T/);

    expect(records).toHaveLength(1);
    expect(store.emit).toHaveBeenCalledWith("merger:autostashOrphans", {
      rootDir: dir,
      records,
    });
  });

  it("truncates diff output beyond cap", async () => {
    const longContent = `${"x".repeat(70000)}\n`;
    const sha = createAutostash(dir, `fusion-merger-autostash:FN-2007:${Date.now()}`, longContent);

    const diff = await getAutostashDiff(dir, sha);

    expect(Buffer.byteLength(diff, "utf-8")).toBeLessThanOrEqual(64 * 1024 + 128);
    expect(diff).toContain("… (diff truncated)");
  });
});
