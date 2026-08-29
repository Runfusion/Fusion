// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { mockRunGitCommand, mockCreateResolvedAgentSession } = vi.hoisted(() => ({
  mockRunGitCommand: vi.fn(),
  mockCreateResolvedAgentSession: vi.fn(),
}));

vi.mock("../routes/resolve-diff-base.js", () => ({
  runGitCommand: mockRunGitCommand,
}));

vi.mock("@fusion/engine", () => ({
  // FNXC:TestInfrastructure 2026-07-13-11:05: Missing @fusion/engine barrel exports added for mock completeness (check-mock-completeness.mjs gate).
  resolveMcpServersForStore: vi.fn(async () => ({ servers: [] })),
  createResolvedAgentSession: mockCreateResolvedAgentSession,
}));

import { resolvePrConflicts } from "../pr-conflict-resolver.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Task",
    description: "desc",
    column: "in-review",
    status: "in-review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments: [],
    ...overrides,
  } as Task;
}

function createStore(task: Task): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue(task),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

const settings = {
  defaultProvider: "mock",
  defaultModelId: "scripted",
} as Settings;

async function createRootDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fusion-pr-conflict-resolver-"));
}

describe("resolvePrConflicts", () => {
  const rootDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(rootDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("treats an already-merged base as resolved without making an empty commit", async () => {
    const rootDir = await createRootDir();
    rootDirs.push(rootDir);
    const store = createStore(createTask());
    mockRunGitCommand
      .mockResolvedValueOnce("") // worktree add
      .mockResolvedValueOnce("") // checkout task branch
      .mockResolvedValueOnce("Already up to date.\n") // merge --no-commit --no-ff base
      .mockResolvedValueOnce("") // add -A
      .mockResolvedValueOnce("") // diff --cached --quiet => empty index
      .mockResolvedValueOnce(""); // worktree remove

    const result = await resolvePrConflicts({
      taskId: "FN-001",
      baseRef: "main",
      rootDir,
      store,
      settings,
    });

    expect(result).toMatchObject({
      resolved: true,
      pushed: false,
      conflictedFiles: [],
    });
    expect(result.message).toContain("already merged");
    expect(mockRunGitCommand).not.toHaveBeenCalledWith(expect.arrayContaining(["commit"]), expect.anything(), expect.anything());
    expect(mockRunGitCommand).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]), expect.anything(), expect.anything());
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Skipped PR conflict-free merge commit", "main already merged into fusion/fn-001");
  });

  it("commits and pushes a conflict-free merge when staged changes exist", async () => {
    const rootDir = await createRootDir();
    rootDirs.push(rootDir);
    const store = createStore(createTask());
    mockRunGitCommand
      .mockResolvedValueOnce("") // worktree add
      .mockResolvedValueOnce("") // checkout task branch
      .mockResolvedValueOnce("") // merge --no-commit --no-ff base
      .mockResolvedValueOnce("") // add -A
      .mockRejectedValueOnce(Object.assign(new Error("diff has changes"), { code: 1 })) // diff --cached --quiet => staged changes
      .mockResolvedValueOnce("") // commit
      .mockResolvedValueOnce("") // push
      .mockResolvedValueOnce(""); // worktree remove

    const result = await resolvePrConflicts({
      taskId: "FN-001",
      baseRef: "main",
      rootDir,
      store,
      settings,
    });

    expect(result).toMatchObject({
      resolved: true,
      pushed: true,
      conflictedFiles: [],
    });
    expect(mockRunGitCommand).toHaveBeenCalledWith([
      "commit",
      "-m",
      "fix(FN-5949): merge main into FN-001",
      "-m",
      "Fusion-Task-Id: FN-001",
    ], expect.stringContaining("conflict-fn-001"), 60000);
    expect(mockRunGitCommand).toHaveBeenCalledWith(["push", "-u", "origin", "fusion/fn-001"], expect.stringContaining("conflict-fn-001"), 60000);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Pushed PR branch after conflict-free merge", "fusion/fn-001");
  });

  /*
  FNXC:GrokCliRouting 2026-07-15-09:58:
  Create-PR conflict resolution must forward pluginRunner into createResolvedAgentSession so grok-cli/no-key models resolve getRuntimeById("grok") the same way engine merge does.
  */
  it("forwards optional pluginRunner into createResolvedAgentSession during AI conflict resolution", async () => {
    const rootDir = await createRootDir();
    rootDirs.push(rootDir);
    const store = createStore(createTask());
    const { writeFile, mkdir } = await import("node:fs/promises");
    // Temp worktree path used by the resolver when task.worktree is missing.
    const worktreePath = join(rootDir, ".fusion", "worktrees", "conflict-fn-001");

    const pluginRunner = {
      getRuntimeById: vi.fn().mockReturnValue({ pluginId: "fusion-plugin-grok-runtime", runtime: {} }),
    };

    mockCreateResolvedAgentSession.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    });

    mockRunGitCommand.mockImplementation(async (args: string[], cwd?: string) => {
      const cmd = args.join(" ");
      if (cmd.startsWith("worktree add")) return "";
      if (cmd.startsWith("checkout")) return "";
      if (cmd.startsWith("merge --no-commit")) {
        throw Object.assign(new Error("CONFLICT"), { code: 1 });
      }
      if (cmd === "diff --name-only --diff-filter=U") {
        // Ensure the conflicted file exists under the worktree cwd so marker scan can run.
        await mkdir(cwd ?? worktreePath, { recursive: true }).catch(() => undefined);
        await writeFile(join(cwd ?? worktreePath, "conflicted.txt"), "resolved content\n", "utf8");
        return "conflicted.txt\n";
      }
      if (cmd.startsWith("add -A")) return "";
      if (cmd.startsWith("diff --cached --quiet")) {
        throw Object.assign(new Error("diff has changes"), { code: 1 });
      }
      if (cmd.startsWith("commit")) return "";
      if (cmd.startsWith("push")) return "";
      if (cmd.startsWith("worktree remove")) return "";
      if (cmd.startsWith("merge --abort") || cmd.startsWith("reset --merge")) return "";
      return "";
    });

    const result = await resolvePrConflicts({
      taskId: "FN-001",
      baseRef: "main",
      rootDir,
      store,
      settings,
      pluginRunner,
    });

    expect(result.resolved).toBe(true);
    expect(mockCreateResolvedAgentSession).toHaveBeenCalledTimes(1);
    expect(mockCreateResolvedAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPurpose: "merger",
        pluginRunner,
      }),
    );
  });
});

/*
FNXC:GrokCliRouting 2026-07-15-10:17:
Source-level guard: PR conflict route and resolver must thread a getRuntimeById-capable pluginRunner; non-capable runners are dropped before createResolvedAgentSession.
*/
describe("Grok CLI PluginRunner wiring for PR conflict + merge doors", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("pr-conflict-resolver forwards input.pluginRunner via asSessionPluginRunner into createResolvedAgentSession", () => {
    const source = readFileSync(resolve(here, "../pr-conflict-resolver.ts"), "utf8");
    expect(source).toContain("pluginRunner?: ConflictResolutionPluginRunner");
    expect(source).toContain("pluginRunner: input.pluginRunner");
    expect(source).toContain("pluginRunner: asSessionPluginRunner(pluginRunner)");
    expect(source).toContain("function asSessionPluginRunner");
  });

  it("register-git-github resolve-conflicts prefers engine.getPluginRunner over bare loader", () => {
    const source = readFileSync(resolve(here, "../routes/register-git-github.ts"), "utf8");
    const routeIndex = source.indexOf('router.post("/tasks/:id/pr/resolve-conflicts"');
    expect(routeIndex).toBeGreaterThanOrEqual(0);
    const callIndex = source.indexOf("resolvePrConflicts({", routeIndex);
    expect(callIndex).toBeGreaterThan(routeIndex);
    expect(source.slice(routeIndex, callIndex)).toContain("engine?.getPluginRunner?.()");
    expect(source.slice(routeIndex, callIndex + 400)).toContain("pluginRunner,");
    expect(source.slice(routeIndex, callIndex)).toContain("getRuntimeById");
  });
});
