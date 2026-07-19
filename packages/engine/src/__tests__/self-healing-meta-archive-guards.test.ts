import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSessionRegistry } from "../active-session-registry.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { git, hasGit, hasPg, makeReliabilityFixture } from "./reliability-interactions/_helpers.js";

async function createResolvedMetaPair(settingsOverrides: Record<string, unknown> = {}) {
  const fixture = await makeReliabilityFixture({
    taskId: "FN-5064-FIXTURE",
    task: { id: "FN-5064-FIXTURE", title: "anchor", column: "todo" },
    settings: { metaTaskActiveExecutionGraceMs: 30 * 60_000, ...settingsOverrides },
  });

  const target = await fixture.store.createTask({
    id: "FN-5064-TARGET",
    title: "target",
    description: "target",
    column: "done",
    steps: [],
  } as any);
  const meta = await fixture.store.createTask({
    id: "FN-5064-META",
    title: "Recover target task",
    description: `meta wrapper for ${target.id}`,
    sourceParentTaskId: target.id,
    column: "todo",
    noCommitsExpected: true,
    steps: [],
    worktree: "/tmp/fn-5064-meta",
  } as any);

  return { fixture, target, meta };
}

afterEach(() => {
  vi.restoreAllMocks();
  activeSessionRegistry.clear();
});

const canRun = hasGit && hasPg;
(canRun ? describe : describe.skip)("SelfHealingManager meta auto-archive guards", () => {
  it("skips resolved auto-archive when branch has unique commits", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    const branchName = `fusion/${meta.id.toLowerCase()}`;
    git(fixture.rootDir, `git checkout -b ${branchName}`);
    git(fixture.rootDir, "git commit --allow-empty -m \"feat: ahead commit\"");
    git(fixture.rootDir, "git checkout main");
    await fixture.store.updateTask(meta.id, { branch: branchName } as any);
    try {
      const archived = await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      expect(archived).toBe(0);
      expect((await fixture.store.getTask(meta.id))?.column).not.toBe("archived");
      const events = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).filter((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect(events).toHaveLength(1);
      expect((events[0]?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["branch-has-unique-commits"]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips resolved auto-archive when executor activity is recent", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    await fixture.store.updateTask(meta.id, { column: "in-progress", executionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString() } as any);
    try {
      const archived = await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      expect(archived).toBe(0);
      const event = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).find((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect((event?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["recent-executor-activity"]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips resolved auto-archive when taskDone retry is pending", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 2 } as any);
    try {
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      const event = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).find((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect((event?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["task-done-retry-pending"]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("dedupes resolved skipped audits until the guard reason changes", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 1 } as any);
    try {
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      let events = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).filter((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect(events).toHaveLength(1);
      expect((events[0]?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["task-done-retry-pending"]));

      await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 0, status: "merging" } as any);
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      events = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).filter((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect(events).toHaveLength(2);
      expect(events.some((event) => (event.metadata as any)?.blockedBy?.includes("merge-in-progress"))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { updates: { mergeDetails: { commitSha: "abc123" } }, label: "merge commitSha exists" },
    { updates: { status: "merging" }, label: "status merging" },
    { updates: { status: "merging-pr" }, label: "status merging-pr" },
  ])("skips resolved auto-archive when merge is in progress: $label", async ({ updates }) => {
    const { fixture, meta } = await createResolvedMetaPair();
    await fixture.store.updateTask(meta.id, updates as any);
    try {
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      const event = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).find((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect((event?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["merge-in-progress"]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips resolved auto-archive when worktree has active session", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    const activePath = join(fixture.rootDir, "active-session-worktree");
    await mkdir(activePath, { recursive: true });
    await fixture.store.updateTask(meta.id, { worktree: activePath } as any);
    activeSessionRegistry.registerPath(activePath, { taskId: meta.id, kind: "executor", ownerKey: meta.id });
    try {
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      const event = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).find((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect((event?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["active-session"]));
    } finally {
      activeSessionRegistry.unregisterPath(activePath);
      await fixture.cleanup();
    }
  });

  it("collects multiple guard reasons", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 1, status: "merging" } as any);
    try {
      await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      const event = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).find((e) => e.mutationType === "task:auto-archive-meta-resolved-skipped");
      expect((event?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["task-done-retry-pending", "merge-in-progress"]));
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps legitimate resolved meta auto-archive behavior", async () => {
    const { fixture, meta } = await createResolvedMetaPair();
    try {
      const archived = await fixture.selfHeal.autoArchiveResolvedMetaTasks();
      expect(archived).toBe(1);
      expect((await fixture.store.getTask(meta.id))?.column).toBe("archived");
      const audits = await fixture.store.getRunAuditEventsAsync({ limit: 200 });
      expect(audits.some((event) => event.mutationType === "task:auto-archived-meta-resolved")).toBe(true);
      expect(audits.some((event) => event.mutationType === "task:auto-archive-meta-resolved-skipped")).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("emits stalled skipped event when guards block stalled archive", async () => {
    // FNXC:PgMigrationQuarantine 2026-07-17-18:30: pin Date for stale-archive thresholds while retaining real timers so PostgreSQL fixture I/O cannot deadlock.
    const now = new Date("2026-05-18T12:00:00.000Z");
    vi.setSystemTime(now);
    const { fixture, meta } = await createResolvedMetaPair({ metaTaskStallAutoCloseMs: 60_000 });
    await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 1 } as any);
    vi.setSystemTime(new Date(now.getTime() + 2 * 60 * 60_000));
    try {
      const archived = await fixture.selfHeal.autoArchiveStalledMetaTasks();
      expect(archived).toBe(0);
      const event = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).find((e) => e.mutationType === "task:auto-archive-meta-stalled-skipped");
      expect(event).toBeTruthy();
      expect((event?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["task-done-retry-pending"]));
    } finally {
      vi.useRealTimers();
      await fixture.cleanup();
    }
  });

  it("dedupes stalled skipped audits until the guard reason changes", async () => {
    // FNXC:PgMigrationQuarantine 2026-07-17-18:30: pin Date for stale-archive thresholds while retaining real timers so PostgreSQL fixture I/O cannot deadlock.
    const now = new Date("2026-05-18T12:00:00.000Z");
    vi.setSystemTime(now);
    const { fixture, meta } = await createResolvedMetaPair({ metaTaskStallAutoCloseMs: 60_000 });
    await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 1 } as any);
    vi.setSystemTime(new Date(now.getTime() + 2 * 60 * 60_000));
    try {
      await fixture.selfHeal.autoArchiveStalledMetaTasks();
      await fixture.selfHeal.autoArchiveStalledMetaTasks();
      let events = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).filter((e) => e.mutationType === "task:auto-archive-meta-stalled-skipped");
      expect(events).toHaveLength(1);
      expect((events[0]?.metadata as any)?.blockedBy).toEqual(expect.arrayContaining(["task-done-retry-pending"]));

      await fixture.store.updateTask(meta.id, { taskDoneRetryCount: 0, status: "merging" } as any);
      await fixture.selfHeal.autoArchiveStalledMetaTasks();
      events = (await fixture.store.getRunAuditEventsAsync({ limit: 200 })).filter((e) => e.mutationType === "task:auto-archive-meta-stalled-skipped");
      expect(events).toHaveLength(2);
      expect(events.some((event) => (event.metadata as any)?.blockedBy?.includes("merge-in-progress"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await fixture.cleanup();
    }
  });
});
