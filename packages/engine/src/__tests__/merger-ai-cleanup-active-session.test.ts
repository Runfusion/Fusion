import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneExistingAiMergeWorktrees, resolveAiMergeRoot } from "../merger-ai.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { MIN_TEMP_WORKTREE_REAP_AGE_MS } from "../self-healing.js";
import type { RunAuditor } from "../run-audit.js";

const tracked = new Set<string>();
const registeredActivePaths = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterEach(() => {
  /*
  FNXC:EngineTests 2026-06-14-02:09:
  Engine test files run in parallel and share the active-session singleton. Cleanup must unregister only paths registered by this file so one AI-merge cleanup test cannot erase another file's live session assertion under package load.
  */
  for (const path of registeredActivePaths) {
    activeSessionRegistry.unregisterPath(path);
  }
  registeredActivePaths.clear();
  for (const dir of tracked) {
    try { rmSync(dir, RM); } catch { /* best effort */ }
  }
  tracked.clear();
});

function makeAudit() {
  const events: any[] = [];
  const audit: RunAuditor = {
    git: vi.fn(async (event: any) => { events.push(event); }),
    database: vi.fn(async () => undefined),
    filesystem: vi.fn(async () => undefined),
    sandbox: vi.fn(async () => undefined),
  };
  return { audit, events };
}

function tempProjectRoot(): string {
  const dir = join(tmpdir(), `fusion-ai-merge-active-session-project-${Math.random().toString(36).slice(2)}-`);
  mkdirSync(dir, { recursive: true });
  tracked.add(dir);
  return dir;
}

function tempAiMergeDir(rootDir: string, name: string): string {
  const dir = join(resolveAiMergeRoot(rootDir), name);
  mkdirSync(dir, { recursive: true });
  tracked.add(dir);
  return dir;
}

function makeAge(path: string, ageMs: number): void {
  const old = new Date(Date.now() - ageMs);
  utimesSync(path, old, old);
}

describe("AI merge active-session pruning", () => {
  it("pruneExistingAiMergeWorktrees skips active-session paths", async () => {
    const projectRoot = tempProjectRoot();
    const stale = tempAiMergeDir(projectRoot, "fusion-ai-merge-fn-779-active");
    const canonical = realpathSync(stale);
    activeSessionRegistry.registerPath(canonical, { taskId: "FN-779", kind: "ai-merge", ownerKey: "ai-merge:FN-779:attempt-1" });
    registeredActivePaths.add(canonical);
    const { audit, events } = makeAudit();

    await expect(pruneExistingAiMergeWorktrees("FN-779", projectRoot, audit, vi.fn(async () => undefined))).resolves.toBe(0);
    expect(existsSync(stale)).toBe(true);
    expect(events).toEqual([]);

    activeSessionRegistry.unregisterPath(canonical);
    registeredActivePaths.delete(canonical);
    makeAge(stale, MIN_TEMP_WORKTREE_REAP_AGE_MS + 1_000);
    await expect(pruneExistingAiMergeWorktrees("FN-779", projectRoot, audit, vi.fn(async () => undefined))).resolves.toBe(1);
    expect(existsSync(stale)).toBe(false);
  });
});
