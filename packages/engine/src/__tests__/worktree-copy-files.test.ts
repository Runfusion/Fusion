import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyConfiguredWorktreeFiles } from "../worktree/worktree-copy-files.js";

const cleanupPaths: string[] = [];
function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("copyConfiguredWorktreeFiles", () => {
  it("copies configured regular files to the same relative worktree path", async () => {
    const rootDir = makeDir("fn-copy-root-");
    const worktreePath = makeDir("fn-copy-worktree-");
    mkdirSync(join(rootDir, "config"), { recursive: true });
    writeFileSync(join(rootDir, ".env"), "SECRET=redacted\n", "utf-8");
    writeFileSync(join(rootDir, "config", "local.env"), "LOCAL=1\n", "utf-8");

    const results = await copyConfiguredWorktreeFiles({
      rootDir,
      worktreePath,
      paths: [".env", "config/local.env"],
      taskId: "FN-6943",
    });

    expect(results.map((result) => result.outcome)).toEqual(["copied", "copied"]);
    expect(readFileSync(join(worktreePath, ".env"), "utf-8")).toBe("SECRET=redacted\n");
    expect(readFileSync(join(worktreePath, "config", "local.env"), "utf-8")).toBe("LOCAL=1\n");
  });

  it("skips blank and duplicate entries without extra writes", async () => {
    const rootDir = makeDir("fn-copy-root-");
    const worktreePath = makeDir("fn-copy-worktree-");
    writeFileSync(join(rootDir, ".env"), "first\n", "utf-8");

    const results = await copyConfiguredWorktreeFiles({
      rootDir,
      worktreePath,
      paths: ["", " .env ", ".env"],
      taskId: "FN-6943",
    });

    expect(results.map((result) => result.reason ?? result.outcome)).toEqual(["blank", "copied", "duplicate"]);
    expect(readFileSync(join(worktreePath, ".env"), "utf-8")).toBe("first\n");
  });

  it("rejects absolute and traversal paths before reading or writing", async () => {
    const rootDir = makeDir("fn-copy-root-");
    const worktreePath = makeDir("fn-copy-worktree-");
    const logger = { warn: vi.fn() };

    const results = await copyConfiguredWorktreeFiles({
      rootDir,
      worktreePath,
      paths: ["/tmp/outside.env", "../outside.env", "nested/../../outside.env"],
      taskId: "FN-6943",
      logger,
    });

    expect(results.map((result) => result.reason)).toEqual(["absolute-path", "path-traversal", "path-traversal"]);
    expect(existsSync(join(worktreePath, "outside.env"))).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("skips missing sources and directories as non-fatal diagnostics", async () => {
    const rootDir = makeDir("fn-copy-root-");
    const worktreePath = makeDir("fn-copy-worktree-");
    mkdirSync(join(rootDir, "config"), { recursive: true });

    const results = await copyConfiguredWorktreeFiles({
      rootDir,
      worktreePath,
      paths: ["missing.env", "config"],
      taskId: "FN-6943",
    });

    expect(results.map((result) => result.reason)).toEqual(["missing", "non-regular"]);
    expect(existsSync(join(worktreePath, "missing.env"))).toBe(false);
    expect(existsSync(join(worktreePath, "config"))).toBe(false);
  });

  it("emits audit events without exposing file contents", async () => {
    const rootDir = makeDir("fn-copy-root-");
    const worktreePath = makeDir("fn-copy-worktree-");
    writeFileSync(join(rootDir, ".env"), "SECRET=redacted\n", "utf-8");
    const filesystem = vi.fn().mockResolvedValue(undefined);

    await copyConfiguredWorktreeFiles({
      rootDir,
      worktreePath,
      paths: [".env"],
      taskId: "FN-6943",
      audit: { filesystem },
    });

    expect(filesystem).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:copy-file",
      target: "FN-6943",
      metadata: expect.objectContaining({ path: ".env", outcome: "copied" }),
    }));
    expect(JSON.stringify(filesystem.mock.calls)).not.toContain("SECRET=redacted");
  });
});
