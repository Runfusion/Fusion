// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import type { ApiRoutesContext } from "../routes/types.js";
import { request as performRequest } from "../test-request.js";

const { mockResolvePrConflicts, mockRunGitCommand } = vi.hoisted(() => ({
  mockResolvePrConflicts: vi.fn(),
  mockRunGitCommand: vi.fn(),
}));

vi.mock("../pr-conflict-resolver.js", () => ({
  resolvePrConflicts: mockResolvePrConflicts,
}));

vi.mock("../routes/resolve-diff-base.js", () => ({
  runGitCommand: mockRunGitCommand,
}));

import {
  computePrPreflight,
  prRouteCommandRunner,
  registerGitGitHubRoutes,
  resolvePrBaseRef,
} from "../routes/register-git-github.js";

type CommandResult = Awaited<ReturnType<typeof prRouteCommandRunner.tryRun>>;

function success(stdout: string): CommandResult {
  return { ok: true, stdout };
}

function failure(): CommandResult {
  return { ok: false, error: new Error("unavailable"), stdout: "", stderr: "" };
}

function createRouteApp(task: Task): express.Express {
  const store = {
    getTask: vi.fn().mockResolvedValue(task),
    getSettings: vi.fn().mockResolvedValue({}),
    getRootDir: vi.fn().mockReturnValue("/repo"),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
  const router = express.Router();
  registerGitGitHubRoutes({
    router,
    store,
    options: {},
    getProjectContext: vi.fn().mockResolvedValue({ store, engine: undefined, projectId: undefined }),
  } as unknown as ApiRoutesContext);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

async function post(app: express.Express, path: string, body: object): Promise<{ status: number; body: unknown }> {
  const response = await performRequest(app, "POST", path, JSON.stringify(body), { "Content-Type": "application/json" });
  return { status: response.status, body: response.body };
}

describe("resolvePrBaseRef", () => {
  let tryRun: ReturnType<typeof vi.spyOn>;
  let run: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  const originalGitHubRepository = process.env.GITHUB_REPOSITORY;

  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = "owner/repo";
    tryRun = vi.spyOn(prRouteCommandRunner, "tryRun");
    run = vi.spyOn(prRouteCommandRunner, "run");
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalGitHubRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalGitHubRepository;
    }
    vi.restoreAllMocks();
  });

  function mockDivergentRemoteBase(): void {
    tryRun.mockImplementation(async (command: string) => {
      if (command === "git fetch origin 'dev' --no-tags") return success("");
      if (command === "git rev-parse --verify 'origin/dev'") return success("041fbd7");
      if (command === "git rev-parse --verify 'dev'") return success("41347f2");
      if (command.startsWith("git ls-remote") || command.startsWith("git merge-tree")) return failure();
      throw new Error(`Unexpected PR base command: ${command}`);
    });
    run.mockImplementation(async (command: string) => command.startsWith("git rev-list") ? "1" : "");
    mockRunGitCommand.mockImplementation(async (args: string[]) => args[0] === "rev-list" ? "1" : "");
  }

  it("refreshes and selects origin/dev instead of a divergent local dev", async () => {
    tryRun
      .mockResolvedValueOnce(success(""))
      .mockResolvedValueOnce(success("041fbd7"))
      .mockResolvedValueOnce(success("41347f2"));

    await expect(resolvePrBaseRef("/repo", "dev")).resolves.toBe("origin/dev");

    expect(tryRun.mock.calls.map(([command]) => command)).toEqual([
      "git fetch origin 'dev' --no-tags",
      "git rev-parse --verify 'origin/dev'",
      "git rev-parse --verify 'dev'",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("base=dev"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("localSha=41347f2"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("remoteSha=041fbd7"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("selected=origin/dev"));
  });

  it("passes origin/dev to production preflight comparisons when local dev diverges", async () => {
    tryRun.mockImplementation(async (command: string) => {
      if (command === "git fetch origin 'dev' --no-tags") return success("");
      if (command === "git rev-parse --verify 'origin/dev'") return success("041fbd7");
      if (command === "git rev-parse --verify 'dev'") return success("41347f2");
      if (command.startsWith("git ls-remote")) return { ...failure(), code: 2 };
      if (command.startsWith("git merge-tree")) return success("");
      throw new Error(`Unexpected preflight command: ${command}`);
    });
    run.mockImplementation(async (command: string) => command.startsWith("git rev-list") ? "1" : "");
    const task = { id: "FN-9523", title: "Task", description: "", column: "in-review", status: "in-review" } as Task;

    const preflight = await computePrPreflight(task, "/repo", "dev");

    expect(preflight.commitsPresent).toBe(true);
    expect(run.mock.calls.map(([command]) => command)).toEqual(expect.arrayContaining([
      "git rev-list --count 'origin/dev'..'fusion/fn-9523'",
      "git log --no-merges 'origin/dev'..'fusion/fn-9523' --format=%H%x09%s%x09%an",
      "git diff --numstat 'origin/dev'..'fusion/fn-9523'",
      "git diff --name-status 'origin/dev'..'fusion/fn-9523'",
    ]));
    expect(tryRun).toHaveBeenCalledWith(
      "git merge-tree --write-tree --name-only 'origin/dev' 'fusion/fn-9523'",
      "/repo",
      expect.any(Number),
    );
  });

  it("uses origin/dev in push validation and conflict resolution routes when local dev diverges", async () => {
    const task = {
      id: "FN-9523",
      title: "Task",
      description: "",
      column: "in-review",
      status: "in-review",
      branch: "fusion/fn-9523",
    } as Task;
    mockDivergentRemoteBase();
    mockResolvePrConflicts.mockResolvedValue({ resolved: true, pushed: false, conflictedFiles: [], message: "resolved" });

    const app = createRouteApp(task);
    const pushResponse = await post(app, "/api/tasks/FN-9523/pr/push-branch", { base: "dev" });
    const conflictResponse = await post(app, "/api/tasks/FN-9523/pr/resolve-conflicts", { base: "dev" });

    expect(pushResponse.status).toBe(200);
    expect(conflictResponse.status).toBe(200);
    expect(mockRunGitCommand).toHaveBeenCalledWith(
      ["rev-list", "--count", "origin/dev..fusion/fn-9523"],
      "/repo",
      10_000,
    );
    expect(mockResolvePrConflicts).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-9523",
      baseRef: "origin/dev",
      rootDir: "/repo",
    }));
  });

  it("does not warn when local and remote refs resolve to the same commit", async () => {
    tryRun
      .mockResolvedValueOnce(success(""))
      .mockResolvedValueOnce(success("041fbd7"))
      .mockResolvedValueOnce(success("041fbd7"));

    await expect(resolvePrBaseRef("/repo", "dev")).resolves.toBe("origin/dev");

    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a verified local branch when the remote ref remains unavailable", async () => {
    tryRun
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(success("41347f2"));

    await expect(resolvePrBaseRef("/repo", "dev")).resolves.toBe("dev");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses an available remote ref when no local branch exists", async () => {
    tryRun
      .mockResolvedValueOnce(success(""))
      .mockResolvedValueOnce(success("041fbd7"))
      .mockResolvedValueOnce(failure());

    await expect(resolvePrBaseRef("/repo", "dev")).resolves.toBe("origin/dev");
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves the base-branch fallback when neither ref is usable", async () => {
    tryRun.mockResolvedValue(failure());

    await expect(resolvePrBaseRef("/repo", "dev")).resolves.toBe("dev");
    expect(warn).not.toHaveBeenCalled();
  });
});
