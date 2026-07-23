import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree } from "../../worktree/worktree-acquisition.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

describe.skipIf(!hasGit || !hasPg)("reliability interactions: worktree init stderr surfacing", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function setup() {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-4834-T",
      settings: {
        worktreeInitCommand: "pnpm install --frozen-lockfile",
      },
      task: {
        column: "todo",
        branch: undefined,
        worktree: undefined,
      },
    });
    fixtures.push(fixture);
    const store = {
      updateTask: fixture.store.updateTask.bind(fixture.store),
      logEntry: vi.fn(fixture.store.logEntry.bind(fixture.store)),
    } as const;
    return { fixture, store };
  }

  it("FN-4834: surfaces stderr output in init failure outcome", async () => {
    const { fixture, store } = await setup();
    const runConfiguredCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: `${"x".repeat(220)}\nERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE\n${"y".repeat(220)}`,
      stdout: "",
    });

    await expect(acquireTaskWorktree({
      task: fixture.task,
      rootDir: fixture.rootDir,
      store: store as any,
      settings: fixture.settings,
      createWorktree: vi.fn().mockResolvedValue({ path: `${fixture.rootDir}/.worktrees/fn-4834-t`, branch: "fusion/fn-4834-t" }),
      runConfiguredCommand,
      runInitCommand: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toBeTruthy();

    const failureCall = store.logEntry.mock.calls.find((call: unknown[]) => String(call[1]).startsWith("Worktree init command failed"));
    expect(failureCall).toBeDefined();
    const outcome = String(failureCall?.[2] ?? "");
    expect(outcome).toContain("ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE");
    expect(outcome.length).toBeLessThanOrEqual(2_100);
  });

  it("FN-4834: falls back to stdout when stderr is empty", async () => {
    const { fixture, store } = await setup();
    const runConfiguredCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "   ",
      stdout: "pnpm diagnostic: lockfile is out of sync",
    });

    await expect(acquireTaskWorktree({
      task: fixture.task,
      rootDir: fixture.rootDir,
      store: store as any,
      settings: fixture.settings,
      createWorktree: vi.fn().mockResolvedValue({ path: `${fixture.rootDir}/.worktrees/fn-4834-t`, branch: "fusion/fn-4834-t" }),
      runConfiguredCommand,
      runInitCommand: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toBeTruthy();

    const failureCall = store.logEntry.mock.calls.find((call: unknown[]) => String(call[1]).startsWith("Worktree init command failed"));
    expect(String(failureCall?.[2] ?? "")).toContain("pnpm diagnostic: lockfile is out of sync");
  });

  it("FN-4834: falls back to spawnError when streams are absent", async () => {
    const { fixture, store } = await setup();
    const runConfiguredCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      spawnError: new Error("ENOENT: pnpm not found"),
    });

    await expect(acquireTaskWorktree({
      task: fixture.task,
      rootDir: fixture.rootDir,
      store: store as any,
      settings: fixture.settings,
      createWorktree: vi.fn().mockResolvedValue({ path: `${fixture.rootDir}/.worktrees/fn-4834-t`, branch: "fusion/fn-4834-t" }),
      runConfiguredCommand,
      runInitCommand: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toBeTruthy();

    const failureCall = store.logEntry.mock.calls.find((call: unknown[]) => String(call[1]).startsWith("Worktree init command failed"));
    const outcome = String(failureCall?.[2] ?? "");
    expect(outcome).toContain("ENOENT");
    expect(outcome.length).toBeGreaterThan(0);
  });
});
