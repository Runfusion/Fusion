// @vitest-environment node

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureProjectGitReadiness } from "@fusion/core";
import { registerProjectRoutes } from "../register-project-routes.js";
import { request } from "../../test-request.js";

const execFileAsync = promisify(execFile);
const getOrCreateProjectStore = vi.fn();
const getSettingsByScope = vi.fn();
const updateSettings = vi.fn();

vi.mock("../../project-store-resolver.js", () => ({
  getOrCreateProjectStore: (...args: unknown[]) => getOrCreateProjectStore(...args),
  evictProjectStore: vi.fn(),
}));

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

function appFor(central: Record<string, unknown>) {
  const router = express.Router();
  registerProjectRoutes({
    router,
    options: { centralCore: central },
    runtimeLogger: { child: () => ({ warn: vi.fn() }), warn: vi.fn() },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return app;
}

describe("POST /api/projects Git readiness", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    getSettingsByScope.mockResolvedValue({ global: {}, project: {} });
  });

  afterEach(() => {
    cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
    getOrCreateProjectStore.mockReset();
    getSettingsByScope.mockReset();
    updateSettings.mockReset();
  });

  function tempDir(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(path);
    return path;
  }

  function centralFor(outcome: "registered" | "existing" | "reattached" = "registered") {
    const updateProject = vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      name: "Registration test",
      path: currentPath,
      status: patch.status,
      createdAt: new Date(0).toISOString(),
    }));
    const ensureProjectForPath = vi.fn(async (input: { path: string }) => {
      const gitReadiness = await ensureProjectGitReadiness(input.path);
      return {
        project: {
          id: "project-1",
          name: "Registration test",
          path: input.path,
          status: "initializing",
          createdAt: new Date(0).toISOString(),
        },
        reattached: outcome === "reattached",
        outcome,
        gitRepository: gitReadiness.outcome,
        integrationBranches: gitReadiness.integrationBranches,
      };
    });
    const central = {
      isInitialized: () => true,
      ensureProjectForPath,
      updateProject,
    };
    return { central, ensureProjectForPath, updateProject };
  }

  let currentPath = "";

  it.each([
    ["existing", "empty non-Git directory"],
    ["init", "unborn Git directory"],
  ] as const)("does not return success for %s until %s is ready", async (mode, label) => {
    currentPath = tempDir(`fusion-dashboard-${mode}-`);
    if (mode === "init") await git(currentPath, ["init"]);
    const { central, ensureProjectForPath, updateProject } = centralFor();
    getOrCreateProjectStore.mockResolvedValue({ getSettingsByScope, updateSettings });

    const response = await request(
      appFor(central),
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Registration test", path: currentPath, gitSetupMode: mode }),
      { "content-type": "application/json" },
    );

    expect(response.status, label).toBe(201);
    expect(ensureProjectForPath).toHaveBeenCalledTimes(1);
    expect(updateProject).toHaveBeenCalledWith("project-1", { status: "active" });
    await expect(git(currentPath, ["rev-parse", "--verify", "HEAD^{commit}"])).resolves.toMatch(/^[0-9a-f]+$/);
    const integrationBranch = await git(currentPath, ["symbolic-ref", "--short", "HEAD"]);
    await expect(git(currentPath, ["rev-parse", "--verify", `refs/heads/${integrationBranch}`])).resolves.toMatch(/^[0-9a-f]+$/);
    await git(currentPath, ["worktree", "add", "-b", `fusion/${mode}`, join(currentPath, "task-worktree"), "HEAD"]);
    await git(currentPath, ["worktree", "remove", "--force", join(currentPath, "task-worktree")]);
    mkdirSync(join(currentPath, ".worktrees"), { recursive: true });
    expect(await git(currentPath, ["check-ignore", "-q", ".worktrees/task"])).toBe("");
  });

  it("registers a cloned checkout only after the shared readiness seam", async () => {
    const source = tempDir("fusion-dashboard-clone-source-");
    await git(source, ["init"]);
    await git(source, ["config", "user.name", "Clone User"]);
    await git(source, ["config", "user.email", "clone@example.com"]);
    writeFileSync(join(source, "README.md"), "clone\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "source"]);
    currentPath = join(tempDir("fusion-dashboard-clone-parent-"), "checkout");
    const { central, ensureProjectForPath } = centralFor();
    getOrCreateProjectStore.mockResolvedValue({ getSettingsByScope, updateSettings });

    const response = await request(
      appFor(central),
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Clone test", path: currentPath, gitSetupMode: "clone", cloneUrl: source }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(ensureProjectForPath).toHaveBeenCalledTimes(1);
    await expect(git(currentPath, ["rev-parse", "--verify", "HEAD^{commit}"])).resolves.toMatch(/^[0-9a-f]+$/);
    const integrationBranch = await git(currentPath, ["symbolic-ref", "--short", "HEAD"]);
    await expect(git(currentPath, ["rev-parse", "--verify", `refs/heads/${integrationBranch}`])).resolves.toMatch(/^[0-9a-f]+$/);
    mkdirSync(join(currentPath, ".fusion"), { recursive: true });
    expect(await git(currentPath, ["check-ignore", "-q", ".fusion/project.json"])).toBe("");
  });

  it("persists an adopted master integration branch for a new registration", async () => {
    currentPath = tempDir("fusion-dashboard-master-");
    await git(currentPath, ["init", "-b", "master"]);
    await git(currentPath, ["config", "user.name", "Master User"]);
    await git(currentPath, ["config", "user.email", "master@example.com"]);
    writeFileSync(join(currentPath, "README.md"), "master\n");
    await git(currentPath, ["add", "README.md"]);
    await git(currentPath, ["commit", "-m", "master"]);
    const { central } = centralFor();
    getOrCreateProjectStore.mockResolvedValue({ getSettingsByScope, updateSettings });

    const response = await request(
      appFor(central),
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Master test", path: currentPath, gitSetupMode: "existing" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await expect(git(currentPath, ["rev-parse", "--verify", "refs/heads/master"])).resolves.toMatch(/^[0-9a-f]+$/);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ integrationBranch: "master" }));
  });

  it("persists an adopted remote-only integration branch", async () => {
    const upstreamPath = tempDir("fusion-dashboard-remote-only-upstream-");
    const cloneParent = tempDir("fusion-dashboard-remote-only-clone-");
    currentPath = join(cloneParent, "checkout");
    await git(upstreamPath, ["init", "-b", "develop"]);
    await git(upstreamPath, ["config", "user.name", "Remote User"]);
    await git(upstreamPath, ["config", "user.email", "remote@example.com"]);
    writeFileSync(join(upstreamPath, "README.md"), "develop\n");
    await git(upstreamPath, ["add", "README.md"]);
    await git(upstreamPath, ["commit", "-m", "develop"]);
    await git(cloneParent, ["clone", "--branch", "develop", "--single-branch", upstreamPath, currentPath]);
    await git(currentPath, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    await git(currentPath, ["checkout", "--detach", "HEAD"]);
    await git(currentPath, ["branch", "-D", "develop"]);
    const { central } = centralFor();
    getOrCreateProjectStore.mockResolvedValue({ getSettingsByScope, updateSettings });

    const response = await request(
      appFor(central),
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Remote-only test", path: currentPath, gitSetupMode: "existing" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    await expect(git(currentPath, ["rev-parse", "--verify", "refs/heads/develop"])).resolves.toBe(
      await git(currentPath, ["rev-parse", "refs/remotes/origin/develop"]),
    );
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ integrationBranch: "develop" }));
  });

  it.each(["existing", "reattached"] as const)("persists a single reconciled branch for %s outcomes", async (outcome) => {
    currentPath = tempDir(`fusion-dashboard-${outcome}-`);
    await git(currentPath, ["init", "-b", "master"]);
    await git(currentPath, ["config", "user.name", "Outcome User"]);
    await git(currentPath, ["config", "user.email", "outcome@example.com"]);
    writeFileSync(join(currentPath, "README.md"), `${outcome}\n`);
    await git(currentPath, ["add", "README.md"]);
    await git(currentPath, ["commit", "-m", outcome]);
    const { central } = centralFor(outcome);
    getOrCreateProjectStore.mockResolvedValue({ getSettingsByScope, updateSettings });

    const response = await request(
      appFor(central),
      "POST",
      "/api/projects",
      JSON.stringify({ name: `${outcome} test`, path: currentPath, gitSetupMode: "existing" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ integrationBranch: "master" }));
  });

  it("does not overwrite an explicitly configured project integration branch", async () => {
    currentPath = tempDir("fusion-dashboard-explicit-branch-");
    await git(currentPath, ["init", "-b", "master"]);
    await git(currentPath, ["config", "user.name", "Explicit User"]);
    await git(currentPath, ["config", "user.email", "explicit@example.com"]);
    writeFileSync(join(currentPath, "README.md"), "master\n");
    await git(currentPath, ["add", "README.md"]);
    await git(currentPath, ["commit", "-m", "master"]);
    getSettingsByScope.mockResolvedValue({ global: {}, project: { integrationBranch: "operator/release" } });
    const { central } = centralFor();
    getOrCreateProjectStore.mockResolvedValue({ getSettingsByScope, updateSettings });

    const response = await request(
      appFor(central),
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Explicit branch test", path: currentPath, gitSetupMode: "existing" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(updateSettings.mock.calls.some(([patch]) => "integrationBranch" in (patch as Record<string, unknown>))).toBe(false);
  });

  it("does not activate or register when the readiness seam fails", async () => {
    currentPath = tempDir("fusion-dashboard-failure-");
    const ensureProjectForPath = vi.fn(async () => { throw new Error("Git baseline failed"); });
    const updateProject = vi.fn();
    const response = await request(
      appFor({ isInitialized: () => true, ensureProjectForPath, updateProject }),
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Failure", path: currentPath, gitSetupMode: "existing" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("Git baseline failed");
    expect(ensureProjectForPath).toHaveBeenCalledTimes(1);
    expect(updateProject).not.toHaveBeenCalled();
  });
});
