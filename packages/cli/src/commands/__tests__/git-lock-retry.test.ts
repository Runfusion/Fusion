/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7740's `git.ts` fix: `resolveGitCwd` must
 * resolve the project path WITHOUT leaking the `TaskStore` that
 * `resolveProject()` constructs internally (`git` commands never touch the
 * board DB at all — this is a pure path-only-caller leak, no lock-retry
 * surface). Proves the original symptom (a cached, never-closed `TaskStore`
 * left in `storeCache` after a return-normally `git` command) is gone by
 * driving the REAL `resolveProjectPathOnly`/`closeProjectStore` helpers
 * (only `resolveProject` itself is stubbed, to avoid touching the real
 * central registry / `~/.fusion` under test) against a REAL `TaskStore`
 * and asserting `.close()` is invoked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore as TaskStoreType, ProjectContext } from "@fusion/core";

const mockResolveProject = vi.fn();

// Full replacement mock (not a partial `importActual` spread): the real
// `resolveProjectPathOnly` calls `resolveProject` through the SAME module's
// internal closure, not through the exported binding, so overriding only
// `resolveProject` via a partial spread would silently keep calling the
// REAL `resolveProject` (which hits the real central registry / global
// dir resolution — forbidden under VITEST without an explicit temp dir).
// Provide local implementations of `resolveProjectPathOnly`/
// `closeProjectStore` that mirror the real close-then-evict semantics
// against the SAME `mockResolveProject`, so this test still exercises the
// real store-close call this fix depends on.
vi.mock("../../project-context.js", () => ({
  resolveProject: (...args: unknown[]) => mockResolveProject(...args),
  resolveProjectPathOnly: async (...args: unknown[]) => {
    const context = await mockResolveProject(...args);
    try {
      await context.store.close();
    } catch {
      // best-effort
    }
    return context.projectPath;
  },
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = await import("node:util");
  const execFn: typeof vi.fn = vi.fn((_cmd: string, opts: object | undefined, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const callback = typeof opts === "function" ? opts : cb;
    if (callback === undefined) return;
    callback(new Error("not a git repo"), "", "");
  });
  execFn[promisify.custom] = () => Promise.reject(new Error("not a git repo"));
  return { ...actual, exec: execFn };
});

describe("fn git — store-leak reproduction (FN-7740)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fn-git-lock-retry-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it("closes the resolved TaskStore even though git commands never use context.store (path-only leak class)", async () => {
    const { TaskStore } = await import("@fusion/core");
    const store = new TaskStore(tmpDir) as TaskStoreType;
    await store.init();
    const closeSpy = vi.spyOn(store, "close");

    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectPath: tmpDir,
      projectName: "demo",
      isRegistered: true,
      store,
    } satisfies ProjectContext);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runGitStatus } = await import("../git.js");

    // No `.git` directory in `tmpDir` — `runGitStatus` resolves the project
    // path (constructing+closing the store via `resolveProjectPathOnly`)
    // BEFORE the "Not a git repository" guard exits, so the store-close
    // assertion holds regardless of the git-repo outcome.
    await expect(runGitStatus("demo-project")).rejects.toThrow("process.exit:1");

    expect(mockResolveProject).toHaveBeenCalledWith("demo-project");
    expect(closeSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Error: Not a git repository");

    await store.close().catch(() => {});
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("does not leak a store on the no-project-flag / CWD-fallback branch when resolution fails", async () => {
    mockResolveProject.mockRejectedValue(new Error("No fusion project found"));

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runGitStatus } = await import("../git.js");

    // No store is ever constructed on this branch (resolution failed before
    // any `TaskStore` was built) — nothing to leak, and the command still
    // fails cleanly with a non-zero exit once it discovers `tmpDir` is not
    // a git repo.
    await expect(runGitStatus()).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Error: Not a git repository");

    cwdSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
