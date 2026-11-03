import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
FNXC:TempScratchSweep 2026-11-03-08:15 (RUFU-397):
These tests own the safety boundary of widening Fusion's stale-tmpdir sweep to Fusion's own leaked
scratch prefixes. Every assertion here is a refusal the sweep MUST keep: a longer floor than the merge
floor, an active session that stops it, and a list of prefixes it must never touch. The host is never
consulted — the temp root is redirected through the same `node:os` mock the existing sweep tests use,
and the age of each fixture is set with `utimesSync`, so nothing here depends on real tmpfs state.
*/

const osState = vi.hoisted(() => ({ tempRoot: "" }));
const childState = vi.hoisted(() => ({ execCalls: [] as string[] }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, tmpdir: vi.fn(() => osState.tempRoot || actual.tmpdir()) };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: vi.fn((command: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
      childState.execCalls.push(command);
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => {
        if (typeof callback === "function") callback(null, "", "");
      });
      return {} as ReturnType<typeof actual.exec>;
    }),
  };
});

import { activeSessionRegistry } from "../agents/active-session-registry.js";
import {
  MIN_TEMP_WORKTREE_REAP_AGE_MS,
  SelfHealingManager,
  STALE_TEMP_MERGE_WORKTREE_MS,
  TEMP_SCRATCH_REAP_AGE_MS,
} from "../self-healing.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const HOUR = 60 * 60 * 1000;

let sandboxRoot = "";
let projectRoot = "";

beforeEach(() => {
  sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), "fusion-temp-scratch-sandbox-")));
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "fusion-temp-scratch-project-")));
  osState.tempRoot = sandboxRoot;
  childState.execCalls = [];
  activeSessionRegistry.clear();
});

afterEach(() => {
  activeSessionRegistry.clear();
  osState.tempRoot = "";
  childState.execCalls = [];
  for (const dir of [sandboxRoot, projectRoot]) {
    try { rmSync(dir, RM); } catch { /* best effort */ }
  }
});

function makeStore() {
  const audits: any[] = [];
  const store: any = {
    getSettings: vi.fn(async () => ({}) as Record<string, unknown>),
    getTask: vi.fn(async () => ({ id: "FN-1", column: "in-progress" })),
    listTasks: vi.fn(async () => []),
    recordRunAuditEvent: vi.fn(async (event: any) => { audits.push(event); }),
  };
  return { store, audits };
}

function makeManager() {
  const { store, audits } = makeStore();
  return { manager: new SelfHealingManager(store, { rootDir: projectRoot }), audits };
}

/** A leaked scratch directory containing one file, aged `ageMs`. */
function scratchDir(name: string, ageMs: number): string {
  const dir = join(sandboxRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "payload.bin"), "scratch");
  const old = new Date(Date.now() - ageMs);
  utimesSync(join(dir, "payload.bin"), old, old);
  utimesSync(dir, old, old);
  return dir;
}

function runSweep(manager: SelfHealingManager): Promise<number> {
  return (manager as unknown as { cleanupStaleTempMergeWorktrees(): Promise<number> }).cleanupStaleTempMergeWorktrees();
}

describe("stale-tmpdir sweep covers Fusion's own leaked scratch directories", () => {
  it.each([
    "fusion-code-node-",
    "fusion-git-baseline-",
    "agent-companies-",
    "fusion-feature-video-",
    "fusion-usage-probe-",
    "fn-agent-import-",
    "fn-pr-conflict-",
  ])("reaps an aged %s* leak and audits it under the existing reason vocabulary", async (prefix) => {
    const dir = scratchDir(`${prefix}abc123`, TEMP_SCRATCH_REAP_AGE_MS + HOUR);
    const { manager, audits } = makeManager();

    const cleaned = await runSweep(manager);

    expect(cleaned).toBe(1);
    expect(existsSync(dir)).toBe(false);
    const sweepRows = audits.filter((row) => row.mutationType === "worktree:tempdir-sweep");
    expect(sweepRows).toHaveLength(1);
    expect(sweepRows[0].metadata.success).toBe(true);
    // No new lifecycle owner and no new audit vocabulary: the pre-existing `stale` reason carries it.
    expect(sweepRows[0].metadata.reason).toBe("stale");
  });

  it("keeps the merge/verify floor for its own classes and still reaps an aged merge clean room", async () => {
    const mergeDir = scratchDir("fusion-ai-merge-fn-1-abc123", STALE_TEMP_MERGE_WORKTREE_MS + HOUR);
    const verifyDir = scratchDir("fn-verify-task-xyz", STALE_TEMP_MERGE_WORKTREE_MS + HOUR);
    const { manager } = makeManager();

    const cleaned = await runSweep(manager);

    expect(cleaned).toBe(2);
    expect(existsSync(mergeDir)).toBe(false);
    expect(existsSync(verifyDir)).toBe(false);
  });

  it("holds a scratch leak behind the dedicated longer floor while the merge floor has already passed", async () => {
    // Aged past the merge clean-room floor and past the minimum floor, but short of the scratch floor.
    const scratchAge = STALE_TEMP_MERGE_WORKTREE_MS + MIN_TEMP_WORKTREE_REAP_AGE_MS;
    expect(scratchAge).toBeLessThan(TEMP_SCRATCH_REAP_AGE_MS);
    const scratch = scratchDir("fusion-code-node-keepme", scratchAge);
    const mergeDir = scratchDir("fusion-ai-merge-fn-1-old", scratchAge);
    const { manager } = makeManager();

    const cleaned = await runSweep(manager);

    // The classes are gated independently: one reaps, the other waits, in the same pass.
    expect(cleaned).toBe(1);
    expect(existsSync(mergeDir)).toBe(false);
    expect(existsSync(scratch)).toBe(true);
  });

  it("refuses a scratch directory an active session still holds", async () => {
    const dir = scratchDir("fusion-feature-video-keepme", TEMP_SCRATCH_REAP_AGE_MS + HOUR);
    activeSessionRegistry.registerPath(dir, {
      taskId: "FN-1",
      kind: "ai-merge",
      ownerKey: "ai-merge:FN-1",
    });
    const { manager, audits } = makeManager();

    const cleaned = await runSweep(manager);

    expect(cleaned).toBe(0);
    expect(existsSync(dir)).toBe(true);
    const refusal = audits.find((row) => row.mutationType === "worktree:tempdir-sweep");
    expect(refusal?.metadata.reason).toBe("active-session");
  });

  it("never touches a prefix outside the admission gate, however old it is", async () => {
    // Third-party temp content, plus Fusion's own process-lifetime artifacts whose age proves nothing.
    const protectedDirs = [
      "dgxs7ZbK3x",
      "sane083a1b",
      ".fusion-stale-thing",
      "fn-pkg-lib",
      "fn-bunfs-4242",
      "fn-experiment-run-1",
      "fusion-worktree-sync-project",
      "fusion-agent-export-zzz",
      "fusion-test-workers-9",
      "fusion-engine-0123456789abcdef.sock",
    ].map((name) => {
      const path = join(sandboxRoot, name);
      // The socket entry is a file, not a directory; both shapes must survive.
      writeFileSync(path, "x");
      const old = new Date(Date.now() - 30 * 24 * HOUR);
      utimesSync(path, old, old);
      return path;
    });
    const { manager, audits } = makeManager();

    const cleaned = await runSweep(manager);

    expect(cleaned).toBe(0);
    for (const path of protectedDirs) {
      expect(existsSync(path), path).toBe(true);
    }
    expect(audits.filter((row) => row.mutationType === "worktree:tempdir-sweep")).toHaveLength(0);
  });

  it("scans the temp root with one non-recursive read and never shells out to find or du", async () => {
    scratchDir("fusion-code-node-bounded", TEMP_SCRATCH_REAP_AGE_MS + HOUR);
    const { manager } = makeManager();

    await runSweep(manager);

    // The bounded-scan rule: a recursive walk of the OS temp root can pin I/O for minutes.
    const recursiveScans = childState.execCalls.filter((command) => /(^|\s)(find|du)(\s|$)/.test(command));
    expect(recursiveScans).toEqual([]);
  });

  it("skips the git worktree remove attempt for a plain scratch directory (no registration to remove)", async () => {
    scratchDir("fusion-code-node-noworktree", TEMP_SCRATCH_REAP_AGE_MS + HOUR);
    const { manager, audits } = makeManager();

    await runSweep(manager);

    expect(childState.execCalls.filter((command) => command.startsWith("git worktree remove"))).toEqual([]);
    expect(audits.filter((row) => row.metadata?.reason === "git-remove-failed")).toHaveLength(0);
  });
});
