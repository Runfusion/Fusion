import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@fusion/core";
import { createQualityRoutes } from "../routes/create-routes.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("preview start for done tasks", () => {
  const temps: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts in a QA worktree at the done task merge commit, not project root", async () => {
    const repo = mkdtempSync(join(tmpdir(), "quality-preview-done-"));
    temps.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "readme.md"), "main\n");
    git(repo, ["add", "readme.md"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["checkout", "-b", "fusion/fn-1"]);
    writeFileSync(join(repo, "feature.md"), "task\n");
    git(repo, ["add", "feature.md"]);
    git(repo, ["commit", "-m", "task"]);
    const mergeSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-"]);
    git(repo, ["branch", "-D", "fusion/fn-1"]);

    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.spyOn(core, "superviseSpawn").mockReturnValue({ child, kill: vi.fn() } as never);

    // Preview start does not need a Quality store; ensure we never call getDatabase.
    const ctx = {
      taskStore: {
        getAsyncLayer: () => ({ projectId: "proj", db: { execute: vi.fn() } }),
        getSettings: () => Promise.resolve({ experimentalFeatures: { qualityPlugin: true } }),
        getRootDir: () => repo,
        getTask: vi.fn(async () => ({
          id: "FN-1",
          worktree: undefined,
          column: "done",
          mergeDetails: { commitSha: mergeSha },
        })),
      },
      settings: {},
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as never;

    const routes = createQualityRoutes();
    const start = routes.find((r) => r.method === "POST" && r.path === "/preview/:taskId/start");
    const result = (await start!.handler(
      {
        params: { taskId: "FN-1" },
        query: { projectId: "proj" },
        body: { projectId: "proj" },
      },
      ctx,
    )) as { session?: { cwd?: string; cwdKind?: string; status?: string; ref?: string } };

    expect(result.session?.cwdKind).toBe("qa-worktree");
    expect(result.session?.ref).toBe(mergeSha);
    expect(result.session?.cwd).toContain(".fusion/quality-qa");
    expect(result.session?.status).toBe("running");
    expect(core.superviseSpawn).toHaveBeenCalledWith(
      "pnpm run dev",
      [],
      expect.objectContaining({ cwd: result.session?.cwd, shell: true }),
    );
  });
});
