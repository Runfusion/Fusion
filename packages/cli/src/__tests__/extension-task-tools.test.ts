import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
/*
FNXC:CliTests 2026-06-14-01:25:
FN-6430 requires rescued CLI suites to run on the default timeout after shared HOME isolation, not via the older file-wide 20s timeout.
Keep this worktree-root regression slice fast by relying on module resets and bounded temp fixtures.

FNXC:CliTests 2026-06-15-07:44:
FN-6486 rescues this load-only timeout by closing each real TaskStore before removing its temp root and by using non-hoisted mock cleanup. The suite keeps the worktree-root regression coverage without widening timeouts, adding retries, or changing package worker settings.

FNXC:CliTests 2026-06-17-23:58:
FN-6626 requires these canonical-project-root tool tests to close the extension module's cached TaskStore instances after every case, because fixture-store cleanup alone does not close the second store opened by fn_task_show/fn_task_list.
*/
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { TaskStore, getProjectRootFromWorktree } from "@fusion/core";

function makeCtx(cwd: string) {
  return { cwd } as any;
}

let closeLoadedExtensionStores: (() => Promise<void>) | undefined;

async function loadExtension() {
  const mod = await import("../extension.js");
  closeLoadedExtensionStores = mod.closeCachedStores;
  return mod.default;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("extension task tools resolve repo root from worktrees", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    /*
    FNXC:CliTests 2026-06-21-09:58:
    FN-6839 requires canonical-root fixture cleanup to await cached and direct TaskStore shutdown before temp roots are removed; this preserves the loaded-lane rescue without timeout or worker appeasement.
    */
    await closeLoadedExtensionStores?.();
    closeLoadedExtensionStores = undefined;
    vi.restoreAllMocks();
    vi.doUnmock("@fusion/core");
  });

  it("exports getProjectRootFromWorktree from @fusion/core", () => {
    expect(typeof getProjectRootFromWorktree).toBe("function");
  });

  it("uses canonical project root for fn_task_show and fn_task_list from worktree cwd", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-4904-cli-"));
    const worktreeRoot = join(repoRoot, ".worktrees", "feature");
    let store: TaskStore | undefined;
    try {
      await mkdir(join(repoRoot, ".fusion"), { recursive: true });

      store = new TaskStore(repoRoot);
      await store.init();
      const created = await store.createTask({ description: "Task from canonical root" });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool(def: any) {
          tools.set(def.name, def);
        },
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      const showTool = tools.get("fn_task_show");
      const listTool = tools.get("fn_task_list");
      expect(showTool).toBeTruthy();
      expect(listTool).toBeTruthy();

      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, makeCtx(worktreeRoot));
      const list = await listTool.execute("list", {}, undefined, undefined, makeCtx(worktreeRoot));

      expect(Array.isArray(list.content)).toBe(true);
      expect(typeof list.details?.count).toBe("number");

      expect(show.content[0].text).toContain(created.id);
      expect(show.content[0].text).toContain("Task from canonical root");
      expect(list.content[0].text).toContain(created.id);
    } finally {
      await store?.close();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical project root for task tools from AI merge temp linked worktrees", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-6079-cli-"));
    const mergeRoot = await mkdtemp(join(tmpdir(), "fusion-ai-merge-fn-6079-"));
    let store: TaskStore | undefined;
    try {
      git(repoRoot, "init -q -b main");
      git(repoRoot, "config user.email test@example.com");
      git(repoRoot, "config user.name Test");
      await writeFile(join(repoRoot, "base.txt"), "base\n");
      git(repoRoot, "add -A");
      git(repoRoot, "commit -q -m base");

      store = new TaskStore(repoRoot);
      await store.init();
      const created = await store.createTask({ description: "Task visible from merge worktree" });
      git(repoRoot, `worktree add --detach ${JSON.stringify(mergeRoot)} HEAD`);
      await mkdir(join(mergeRoot, "packages"), { recursive: true });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool(def: any) {
          tools.set(def.name, def);
        },
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      const showTool = tools.get("fn_task_show");
      const listTool = tools.get("fn_task_list");

      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, makeCtx(mergeRoot));
      const list = await listTool.execute("list", {}, undefined, undefined, makeCtx(join(mergeRoot, "packages")));

      expect(show.content[0].text).toContain("Task visible from merge worktree");
      expect(list.content[0].text).toContain(created.id);
    } finally {
      await store?.close();
      try {
        git(repoRoot, `worktree remove --force ${JSON.stringify(mergeRoot)}`);
      } catch {
        // best effort cleanup
      }
      await rm(mergeRoot, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back when getProjectRootFromWorktree is unavailable in no-task context", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-4927-cli-"));
    const worktreeRoot = join(repoRoot, ".worktrees", "ambient");
    let store: TaskStore | undefined;
    try {
      await mkdir(join(repoRoot, ".fusion"), { recursive: true });

      store = new TaskStore(repoRoot);
      await store.init();
      const created = await store.createTask({ description: "Ambient tool check" });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.doMock("@fusion/core", async () => {
        const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
        return {
          ...actual,
          getProjectRootFromWorktree: undefined,
        };
      });

      const extension = await loadExtension();
      const tools = new Map<string, any>();
      extension({
        registerTool(def: any) {
          tools.set(def.name, def);
        },
        registerCommand: vi.fn(),
        registerShortcut: vi.fn(),
        registerFlag: vi.fn(),
        on: vi.fn(),
      } as any);

      const listTool = tools.get("fn_task_list");
      const showTool = tools.get("fn_task_show");

      const list = await listTool.execute("list", {}, undefined, undefined, makeCtx(worktreeRoot));
      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, makeCtx(worktreeRoot));

      expect(Array.isArray(list.content)).toBe(true);
      expect(typeof list.details?.count).toBe("number");
      expect(Array.isArray(show.content)).toBe(true);
      expect(show.content[0]?.text).toContain(created.id);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      await store?.close();
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
