import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePostMergeAuditInvocation } from "../merger.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf-8" }).trim();
}

function createRepoWithFeatureCommit() {
  const dir = mkdtempSync(join(tmpdir(), "fn-4961-audit-"));
  git(dir, "init -b main");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");

  writeFileSync(join(dir, "file.txt"), "a\n");
  git(dir, "add file.txt");
  git(dir, "commit -m base");
  const baseSha = git(dir, "rev-parse HEAD");

  writeFileSync(join(dir, "file.txt"), "a\nb\n");
  git(dir, "add file.txt");
  git(dir, "commit -m main-two");
  const mainTipSha = git(dir, "rev-parse HEAD");

  git(dir, "checkout -b feature");
  writeFileSync(join(dir, "feature.txt"), "c\n");
  git(dir, "add feature.txt");
  git(dir, "commit -m feature");
  const auditSha = git(dir, "rev-parse HEAD");

  return { dir, baseSha, mainTipSha, auditSha };
}

// FN-5518 (FN-4807 pattern): rangebase resolution drives real-git rev-parse / merge-base ceremony; bound but lift the per-test deadline above Vitest's 5s default to absorb pnpm test contention without weakening subprocess guards.
describe("resolvePostMergeAuditInvocation", { timeout: 30_000 }, () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses explicit rebaseMergeBaseSha when present", async () => {
    const { dir, baseSha, auditSha } = createRepoWithFeatureCommit();
    cleanup.push(dir);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    const mergerLog = { log: vi.fn(), warn: vi.fn() };

    const input = await resolvePostMergeAuditInvocation({
      rootDir: dir,
      strategy: "rebase",
      auditSha,
      rebaseMergeBaseSha: baseSha,
      diffBaseRef: undefined,
      mergeTargetBranch: "main",
      taskBaseCommitSha: undefined,
      taskId: "FN-4961",
      store: { appendAgentLog },
      mergerLog,
    });

    expect(input).toMatchObject({ strategy: "rebase", rangeBaseSha: baseSha, rangeHeadSha: auditSha });
    expect(appendAgentLog).not.toHaveBeenCalled();
  });

  it("derives from diffBaseRef when resolvable and ancestor", async () => {
    const { dir, mainTipSha, auditSha } = createRepoWithFeatureCommit();
    cleanup.push(dir);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    const mergerLog = { log: vi.fn(), warn: vi.fn() };

    const input = await resolvePostMergeAuditInvocation({
      rootDir: dir,
      strategy: "rebase",
      auditSha,
      diffBaseRef: mainTipSha,
      mergeTargetBranch: "main",
      taskId: "FN-4961",
      store: { appendAgentLog },
      mergerLog,
    });

    expect(input).toMatchObject({ strategy: "rebase", rangeBaseSha: mainTipSha, rangeHeadSha: auditSha });
    expect(appendAgentLog).toHaveBeenCalledWith(
      "FN-4961",
      expect.stringContaining("from diffBaseRef"),
      "status",
      undefined,
      "merger",
    );
  });

  it("falls back to task base commit sha", async () => {
    const { dir, baseSha, auditSha } = createRepoWithFeatureCommit();
    cleanup.push(dir);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    const mergerLog = { log: vi.fn(), warn: vi.fn() };

    const input = await resolvePostMergeAuditInvocation({
      rootDir: dir,
      strategy: "rebase",
      auditSha,
      diffBaseRef: "missing-ref",
      taskBaseCommitSha: baseSha,
      mergeTargetBranch: "main",
      taskId: "FN-4961",
      store: { appendAgentLog },
      mergerLog,
    });

    expect(input).toMatchObject({ strategy: "rebase", rangeBaseSha: baseSha, rangeHeadSha: auditSha });
    expect(appendAgentLog).toHaveBeenCalledWith(
      "FN-4961",
      expect.stringContaining("from baseCommitSha"),
      "status",
      undefined,
      "merger",
    );
  });

  it("falls back to merge-base when other candidates are unavailable", async () => {
    const { dir, mainTipSha, auditSha } = createRepoWithFeatureCommit();
    cleanup.push(dir);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    const mergerLog = { log: vi.fn(), warn: vi.fn() };

    const input = await resolvePostMergeAuditInvocation({
      rootDir: dir,
      strategy: "rebase",
      auditSha,
      diffBaseRef: auditSha,
      taskBaseCommitSha: "missing",
      mergeTargetBranch: "main",
      taskId: "FN-4961",
      store: { appendAgentLog },
      mergerLog,
    });

    expect(input).toMatchObject({ strategy: "rebase", rangeBaseSha: mainTipSha, rangeHeadSha: auditSha });
    expect(appendAgentLog).toHaveBeenCalledWith(
      "FN-4961",
      expect.stringContaining("from merge-base"),
      "status",
      undefined,
      "merger",
    );
  });

  it("degrades to squash when all candidates are unusable", async () => {
    const { dir, auditSha } = createRepoWithFeatureCommit();
    cleanup.push(dir);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);
    const mergerLog = { log: vi.fn(), warn: vi.fn() };

    const input = await resolvePostMergeAuditInvocation({
      rootDir: dir,
      strategy: "rebase",
      auditSha,
      diffBaseRef: auditSha,
      taskBaseCommitSha: auditSha,
      mergeTargetBranch: "feature",
      taskId: "FN-4961",
      store: { appendAgentLog },
      mergerLog,
    });

    expect(input).toMatchObject({ strategy: "squash", squashSha: auditSha });
    expect(appendAgentLog).toHaveBeenCalledWith(
      "FN-4961",
      expect.stringContaining("post-merge audit degraded to single-commit squash fallback"),
      "status",
      undefined,
      "merger",
    );
    expect(mergerLog.warn).toHaveBeenCalled();
  });

  it("always returns squash input for squash strategy", async () => {
    const { dir, auditSha } = createRepoWithFeatureCommit();
    cleanup.push(dir);
    const appendAgentLog = vi.fn().mockResolvedValue(undefined);

    const input = await resolvePostMergeAuditInvocation({
      rootDir: dir,
      strategy: "squash",
      auditSha,
      mergeTargetBranch: "main",
      taskId: "FN-4961",
      store: { appendAgentLog },
      mergerLog: { log: vi.fn(), warn: vi.fn() },
    });

    expect(input).toMatchObject({ strategy: "squash", squashSha: auditSha });
    expect(appendAgentLog).not.toHaveBeenCalled();
  });
});
