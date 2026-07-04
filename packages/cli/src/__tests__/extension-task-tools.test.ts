/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(rootDir)` harness to the
 * PostgreSQL extension harness. The agent tools now resolve a PG-backed store
 * via `getStore(cwd)` (injected by the harness), so worktree project-root
 * resolution is preserved end-to-end:
 *  - A `.worktrees/<name>` cwd is resolved by the regex in
 *    `getProjectRootFromWorktree` back to `h.rootDir()`, where the harness
 *    injects the shared PG store.
 *  - A real git-linked merge worktree is resolved via
 *    `git rev-parse --git-common-dir`; a separate repoRoot is created and the
 *    shared PG store is injected under it with `__setCachedStoreForTesting` so
 *    the tool resolves the SAME backend (task data is rootDir-independent in PG
 *    mode).
 *  - The filesystem-walk fallback (`getProjectRootFromWorktree` returns null)
 *    is exercised from a plain project subdir.
 *
 * The previous SQLite-only `vi.doMock("@fusion/core")` branch asserted the
 * "warn once when getProjectRootFromWorktree is unavailable" path. That path is
 * unreachable under the static-import rule (the binding is always a function),
 * so it cannot be exercised without a forbidden dynamic module reload; the
 * fallback resolution it gated is still covered by the third case below. The
 * FN-6430/6486/6626/6839 SQLite store-closing rescue comments are obsolete
 * under the harness (it owns store lifecycle) and were removed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getProjectRootFromWorktree } from "@fusion/core";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";
import { __setCachedStoreForTesting } from "../extension.js";

const pgTest = pgDescribe;

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

pgTest("extension task tools resolve repo root from worktrees", () => {
  const h = createPgExtensionHarness("fn-ext-task-tools");

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("exports getProjectRootFromWorktree from @fusion/core", () => {
    expect(typeof getProjectRootFromWorktree).toBe("function");
  });

  it("uses canonical project root for fn_task_show and fn_task_list from worktree cwd", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Task from canonical root" });

    // A `.worktrees/<name>` cwd is resolved by the regex in
    // getProjectRootFromWorktree back to the project root (h.rootDir()), where
    // the harness injects the PG-backed store. The worktree cwd never needs to
    // exist on disk — resolution is path-based.
    const worktreeRoot = join(h.rootDir(), ".worktrees", "feature");

    const api = createMockApi();
    registerExtension(api);
    const showTool = requireTool(api, "fn_task_show");
    const listTool = requireTool(api, "fn_task_list");

    const show = await showTool.execute("show", { id: created.id }, undefined, undefined, { cwd: worktreeRoot });
    const list = await listTool.execute("list", {}, undefined, undefined, { cwd: worktreeRoot });

    expect(Array.isArray(list.content)).toBe(true);
    expect(typeof list.details?.count).toBe("number");

    expect(show.content[0]?.text).toContain(created.id);
    expect(show.content[0]?.text).toContain("Task from canonical root");
    expect(list.content[0]?.text).toContain(created.id);
  });

  it("uses canonical project root for task tools from AI merge temp linked worktrees", async () => {
    const store = h.store();
    const repoRoot = await mkdtemp(join(tmpdir(), "fn-6079-cli-"));
    const mergeRoot = await mkdtemp(join(tmpdir(), "fusion-ai-merge-fn-6079-"));
    try {
      git(repoRoot, "init -q -b main");
      git(repoRoot, "config user.email test@example.com");
      git(repoRoot, "config user.name Test");
      await writeFile(join(repoRoot, "base.txt"), "base\n");
      git(repoRoot, "add -A");
      git(repoRoot, "commit -q -m base");
      // resolveProjectRoot's git-linked-worktree branch only returns repoRoot
      // when it contains a `.fusion` dir, so create one (no store is built here
      // — the shared PG store is injected below).
      await mkdir(join(repoRoot, ".fusion"), { recursive: true });

      const created = await store.createTask({ description: "Task visible from merge worktree" });

      // The merge worktree is a real git worktree of repoRoot, so
      // `git rev-parse --git-common-dir` resolves back to repoRoot. Inject the
      // shared PG store under the project root the tool will resolve to — NOT
      // the raw repoRoot string: git emits canonical absolute paths, so on
      // macOS the /var -> /private/var symlink means the resolved root
      // (`/private/var/.../repoRoot`) differs from the mkdtemp string
      // (`/var/.../repoRoot`) and a raw-key injection would miss the cache and
      // boot a stray backend. getProjectRootFromWorktree mirrors exactly what
      // resolveProjectRoot will key on.
      git(repoRoot, `worktree add --detach ${JSON.stringify(mergeRoot)} HEAD`);
      await mkdir(join(mergeRoot, "packages"), { recursive: true });
      const resolvedRoot = getProjectRootFromWorktree(mergeRoot);
      if (!resolvedRoot) {
        throw new Error("test setup: merge worktree did not resolve to a project root");
      }
      __setCachedStoreForTesting(resolvedRoot, store);

      const api = createMockApi();
      registerExtension(api);
      const showTool = requireTool(api, "fn_task_show");
      const listTool = requireTool(api, "fn_task_list");

      const show = await showTool.execute("show", { id: created.id }, undefined, undefined, { cwd: mergeRoot });
      const list = await listTool.execute("list", {}, undefined, undefined, { cwd: join(mergeRoot, "packages") });

      expect(show.content[0]?.text).toContain("Task visible from merge worktree");
      expect(list.content[0]?.text).toContain(created.id);
    } finally {
      try {
        git(repoRoot, `worktree remove --force ${JSON.stringify(mergeRoot)}`);
      } catch {
        // best effort cleanup
      }
      await rm(mergeRoot, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("falls back to filesystem walk when the worktree resolver does not apply", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "Ambient tool check" });

    // A plain project subdir (not a `.worktrees` path, not a git-linked
    // worktree) makes getProjectRootFromWorktree return null, so
    // resolveProjectRoot falls back to walking up the filesystem until it finds
    // `h.rootDir()/.fusion` — the root the harness injects the PG store under.
    const subdir = join(h.rootDir(), "packages", "cli");
    await mkdir(subdir, { recursive: true });

    const api = createMockApi();
    registerExtension(api);
    const listTool = requireTool(api, "fn_task_list");
    const showTool = requireTool(api, "fn_task_show");

    const list = await listTool.execute("list", {}, undefined, undefined, { cwd: subdir });
    const show = await showTool.execute("show", { id: created.id }, undefined, undefined, { cwd: subdir });

    expect(Array.isArray(list.content)).toBe(true);
    expect(typeof list.details?.count).toBe("number");
    expect(Array.isArray(show.content)).toBe(true);
    expect(show.content[0]?.text).toContain(created.id);
  });
});
