import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("node:child_process");
  vi.unmock("node:fs");
  vi.unmock("../worktree-hooks.js");
  vi.unmock("../worktree-prune.js");
});

describe("worktree prune wiring", () => {
  it("step-session createStepWorktree pairs cleanup deletes with prune reasons", async () => {
    const pruneSpy = vi.fn().mockResolvedValue(undefined);
    const execMock = vi.fn();
    (execMock as any)[Symbol.for("nodejs.util.promisify.custom")] = execMock;

    execMock.mockRejectedValueOnce(new Error("create failed")).mockResolvedValueOnce({ stdout: "", stderr: "" });

    vi.doMock("node:child_process", () => ({ exec: execMock }));
    vi.doMock("../worktree-prune.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../worktree-prune.js")>();
      return { ...actual, pruneWorktreeAdminEntries: pruneSpy };
    });
    vi.doMock("../worktree-hooks.js", () => ({
      installTaskWorktreeIdentityGuard: vi.fn().mockRejectedValue(new Error("guard failed")),
    }));

    const { StepSessionExecutor } = await import("../step-session-executor.js");
    const task = {
      id: "FN-5058",
      title: "t",
      description: "d",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const executor = new StepSessionExecutor({ taskDetail: task, worktreePath: "/repo", rootDir: "/repo", settings: {} as any });
    await expect((executor as any).createStepWorktree(1)).rejects.toThrow("create failed");
    expect(pruneSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "step-session-create-failed" }));

    execMock.mockReset();
    execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({ stdout: "", stderr: "" });
    await expect((executor as any).createStepWorktree(2)).rejects.toThrow("guard failed");
    expect(pruneSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "step-session-guard-failed" }));
  });

  it("step-session cleanup swallows prune helper rejection", async () => {
    const pruneSpy = vi.fn().mockRejectedValue(new Error("prune boom"));
    const execMock = vi.fn();
    (execMock as any)[Symbol.for("nodejs.util.promisify.custom")] = execMock;
    execMock.mockRejectedValueOnce(new Error("create failed")).mockResolvedValueOnce({ stdout: "", stderr: "" });

    vi.doMock("node:child_process", () => ({ exec: execMock }));
    vi.doMock("../worktree-prune.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../worktree-prune.js")>();
      return { ...actual, pruneWorktreeAdminEntries: pruneSpy };
    });
    const { StepSessionExecutor } = await import("../step-session-executor.js");
    const task = {
      id: "FN-5058",
      title: "t",
      description: "d",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const executor = new StepSessionExecutor({ taskDetail: task, worktreePath: "/repo", rootDir: "/repo", settings: {} as any });
    await expect((executor as any).createStepWorktree(3)).rejects.toThrow("create failed");
  });

  it("native backend create calls prune after guard cleanup", async () => {
    const pruneSpy = vi.fn().mockResolvedValue(undefined);
    const execMock = vi.fn();
    (execMock as any)[Symbol.for("nodejs.util.promisify.custom")] = execMock;
    execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({ stdout: "", stderr: "" });

    vi.doMock("node:child_process", () => ({ exec: execMock }));
    vi.doMock("../worktree-prune.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../worktree-prune.js")>();
      return { ...actual, pruneWorktreeAdminEntries: pruneSpy };
    });
    vi.doMock("../worktree-hooks.js", () => ({
      installTaskWorktreeIdentityGuard: vi.fn().mockRejectedValue(new Error("guard failed")),
    }));

    const { NativeWorktreeBackend } = await import("../worktree-backend.js");
    await expect(
      new NativeWorktreeBackend({ audit: { git: vi.fn() } as any }).create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-5058",
        branch: "fusion/fn-5058",
        taskId: "FN-5058",
      }),
    ).rejects.toThrow("guard failed");

    expect(pruneSpy).toHaveBeenCalledWith(expect.objectContaining({ reason: "backend-guard-failed" }));
  });

});

describe("pruneWorktreeAdminEntries helper", () => {
  it("swallows git prune failure and audits success=false metadata", async () => {
    const execMock = vi.fn();
    (execMock as any)[Symbol.for("nodejs.util.promisify.custom")] = execMock;
    execMock.mockRejectedValue(new Error("boom"));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, exec: execMock };
    });

    vi.unmock("../worktree-prune.js");
    const { pruneWorktreeAdminEntries } = await import("../worktree-prune.js");
    const audit = vi.fn().mockResolvedValue(undefined);
    await pruneWorktreeAdminEntries({ rootDir: "/repo", auditor: { git: audit }, reason: "test-failure", target: "/repo/.worktrees/x" });
  });

  it("runs git worktree prune end-to-end in a real repository", async () => {
    vi.unmock("../worktree-prune.js");
    const { pruneWorktreeAdminEntries } = await import("../worktree-prune.js");
    const root = mkdtempSync(join(tmpdir(), "fn-5058-prune-"));
    const repo = join(root, "repo");
    const wt = join(root, "repo-wt");
    mkdirSync(repo, { recursive: true });

    execSync("git init", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: repo });
    execSync('git config user.name "Test"', { cwd: repo });
    writeFileSync(join(repo, "README.md"), "ok\n");
    execSync("git add README.md", { cwd: repo });
    execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
    execSync(`git worktree add ${wt} -b fusion/fn-5058-test`, { cwd: repo, stdio: "ignore" });
    rmSync(wt, { recursive: true, force: true });

    await pruneWorktreeAdminEntries({ rootDir: repo, reason: "integration", target: wt });

    rmSync(root, { recursive: true, force: true });
  });
});
