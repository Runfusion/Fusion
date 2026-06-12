import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneExistingAiMergeWorktrees } from "../merger-ai.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { MIN_TEMP_WORKTREE_REAP_AGE_MS } from "../self-healing.js";
import type { RunAuditor } from "../run-audit.js";

const tracked = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterEach(() => {
  activeSessionRegistry.clear();
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

function tempAiMergeDir(name: string): string {
  const dir = join(tmpdir(), name);
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
    const stale = tempAiMergeDir("fusion-ai-merge-fn-777-active");
    const canonical = realpathSync(stale);
    activeSessionRegistry.registerPath(canonical, { taskId: "FN-777", kind: "executor", ownerKey: "FN-777" });
    const { audit, events } = makeAudit();

    await expect(pruneExistingAiMergeWorktrees("FN-777", process.cwd(), audit, vi.fn(async () => undefined))).resolves.toBe(0);
    expect(existsSync(stale)).toBe(true);
    expect(events).toEqual([]);

    activeSessionRegistry.unregisterPath(canonical);
    makeAge(stale, MIN_TEMP_WORKTREE_REAP_AGE_MS + 1_000);
    await expect(pruneExistingAiMergeWorktrees("FN-777", process.cwd(), audit, vi.fn(async () => undefined))).resolves.toBe(1);
    expect(existsSync(stale)).toBe(false);
  });
});
