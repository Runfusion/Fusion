import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Router } from "express";
import { saveWorkspaceConfig } from "../../../core/src/git/git-repository.js";
import { registerGitGitHubRoutes } from "../routes/register-git-github.js";

const exec = promisify(execFile);
const roots: string[] = [];
async function gitRepo(root: string, name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd });
}

function routes(rootDir: string) {
  const gets = new Map<string, any>(); const posts = new Map<string, any>();
  const router = {
    get: vi.fn((path: string, handler: any) => gets.set(path, handler)),
    post: vi.fn((path: string, handler: any) => posts.set(path, handler)),
    put: vi.fn(), delete: vi.fn(), patch: vi.fn(),
  } as unknown as Router;
  registerGitGitHubRoutes({
    router, store: {}, options: {}, registerDispose: vi.fn(),
    getProjectContext: vi.fn(async () => ({ store: { getRootDir: () => rootDir } })),
    rethrowAsApiError: (error: unknown): never => { throw error; },
  } as never);
  return { get: gets.get("/git/workspace-repos"), post: posts.get("/git/workspace-repos") };
}

/*
FNXC:Workspace 2026-08-20-02:25:
The operator route writes through the core validator, so callers receive typed client errors rather
than a raw server failure when a path cannot become a direct-child workspace member.
*/
describe("workspace repository route", () => {
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it("adds valid members, preserves the default GET shape, and exposes opt-in candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-workspace-route-")); roots.push(root);
    await gitRepo(root, "api"); await gitRepo(root, "web");
    await saveWorkspaceConfig(root, { repos: ["api"] });
    const { get, post } = routes(root);
    const postJson = vi.fn();
    await post({ body: { repo: "web" }, query: {} }, { json: postJson });
    expect(postJson).toHaveBeenCalledWith({ outcome: "added", repos: ["api", "web"] });
    const defaultJson = vi.fn();
    await get({ query: {} }, { json: defaultJson });
    expect(defaultJson).toHaveBeenCalledWith({ repos: ["api", "web"] });
    const candidateJson = vi.fn();
    await get({ query: { includeAvailable: "1" } }, { json: candidateJson });
    expect(candidateJson).toHaveBeenCalledWith({ repos: ["api", "web"], available: [] });
  });

  it("maps invalid members and non-workspaces to route errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-workspace-route-")); roots.push(root);
    await gitRepo(root, "api");
    const { post } = routes(root);
    await expect(post({ body: { repo: "../escape" }, query: {} }, { json: vi.fn() })).rejects.toMatchObject({ statusCode: 400 });
    await expect(post({ body: { repo: "api" }, query: {} }, { json: vi.fn() })).rejects.toMatchObject({ statusCode: 409 });
  });
});
