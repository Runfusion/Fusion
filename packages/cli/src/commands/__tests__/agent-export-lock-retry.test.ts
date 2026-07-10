/**
 * FNXC:CliAgentControl 2026-07-09-00:00:
 * Regression coverage for FN-7740's `agent-export.ts` fix: `getProjectPath`
 * must resolve the project path WITHOUT leaking the cached `TaskStore`
 * `resolveProject()` constructs internally (path-only leak, mirrors
 * `git.ts`), AND `runAgentExport` must close the `AgentStore` it opens on
 * EVERY exit path — the success return AND the no-agents `process.exit(1)`
 * guard. Export is a read (no board writes) so there is no `retryOnLock`
 * surface here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore as TaskStoreType, ProjectContext } from "@fusion/core";

const mockResolveProject = vi.fn();

// See git-lock-retry.test.ts FNXC header for why this is a full replacement
// mock (not a partial `importActual` spread) — the real
// `resolveProjectPathOnly` calls `resolveProject` through the module's own
// closure, bypassing any partial override.
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

describe("fn agent export — store-leak reproduction (FN-7740)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fn-agent-export-lock-retry-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it("closes both the path-only TaskStore and the AgentStore when no agents exist (guard exit path)", async () => {
    const { TaskStore, AgentStore } = await import("@fusion/core");
    const store = new TaskStore(tmpDir) as TaskStoreType;
    await store.init();
    const taskStoreCloseSpy = vi.spyOn(store, "close");

    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectPath: tmpDir,
      projectName: "demo",
      isRegistered: true,
      store,
    } satisfies ProjectContext);

    const agentStoreCloseSpy = vi.spyOn(AgentStore.prototype, "close");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { runAgentExport } = await import("../agent-export.js");

    await expect(runAgentExport(join(tmpDir, "out"), { project: "demo" })).rejects.toThrow("process.exit:1");

    expect(taskStoreCloseSpy).toHaveBeenCalled();
    expect(agentStoreCloseSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("No agents found to export");

    await store.close().catch(() => {});
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("closes both stores on the success return path when agents exist", async () => {
    const { TaskStore, AgentStore } = await import("@fusion/core");
    const store = new TaskStore(tmpDir) as TaskStoreType;
    await store.init();
    const taskStoreCloseSpy = vi.spyOn(store, "close");

    mockResolveProject.mockResolvedValue({
      projectId: "proj-1",
      projectPath: tmpDir,
      projectName: "demo",
      isRegistered: true,
      store,
    } satisfies ProjectContext);

    const agentStore = new AgentStore({ rootDir: join(tmpDir, ".fusion") });
    await agentStore.init();
    await agentStore.createAgent({
      name: "Solo",
      role: "executor",
      title: "Solo Agent",
      metadata: { description: "test agent", skills: [] },
      instructionsText: "Do the thing.",
    });
    agentStore.close();

    const agentStoreCloseSpy = vi.spyOn(AgentStore.prototype, "close");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { runAgentExport } = await import("../agent-export.js");
    await runAgentExport(join(tmpDir, "out"), { project: "demo" });

    expect(taskStoreCloseSpy).toHaveBeenCalled();
    expect(agentStoreCloseSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Agents exported: 1"));

    await store.close().catch(() => {});
    logSpy.mockRestore();
  });
});
