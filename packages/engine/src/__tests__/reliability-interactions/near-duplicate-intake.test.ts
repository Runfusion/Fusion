import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS, TaskStore } from "@fusion/core";
import * as core from "@fusion/core";
import { TriageProcessor } from "../../triage.js";

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-near-dup-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  git(rootDir, "git commit --allow-empty -m init");

  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  await store.updateSettings({ ...DEFAULT_SETTINGS, requirePlanApproval: false });
  const triage = new TriageProcessor(store, rootDir);

  return {
    rootDir,
    store,
    triage,
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

const basePrompt = `# Task: FN-1 - test\n\n**Size:** S\n\n## Review Level: 1\n\n## File Scope\n- packages/dashboard/src/routes/register-git-github.ts\n`;

describe("reliability interactions: near-duplicate intake", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("flags newer task as near-duplicate and records activity", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    await fx.store.createTask({
      title: "Create PR routes missing handlers",
      description: "Missing /api/tasks/:id/pr/options and /api/tasks/:id/pr/preflight and /api/tasks/:id/pr/generate-metadata",
      column: "todo",
    });
    const incoming = await fx.store.createTask({
      title: "Missing handlers for create PR routes",
      description: "GET /api/tasks/:id/pr/options and GET /api/tasks/:id/pr/preflight and POST /api/tasks/:id/pr/generate-metadata all fail",
    });

    await (fx.triage as any).finalizeApprovedTask(incoming, basePrompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(incoming.id);
    expect(updated.column).toBe("todo");
    expect(updated.sourceMetadata?.nearDuplicateOf).toBeTruthy();
    expect(typeof updated.sourceMetadata?.nearDuplicateScore).toBe("number");
    expect(Array.isArray(updated.sourceMetadata?.nearDuplicateSharedTokens)).toBe(true);
    const flaggedActivity = await fx.store.getActivityLog({ type: "task:near-duplicate-flagged", limit: 20 });
    expect(flaggedActivity.some((entry) => entry.taskId === incoming.id)).toBe(true);
    const archivedActivity = await fx.store.getActivityLog({ type: "task:auto-archived-near-duplicate", limit: 20 });
    expect(archivedActivity.some((entry) => entry.taskId === incoming.id)).toBe(false);
  });

  it("does not flag when the only near-duplicate candidate is archived", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const canonical = await fx.store.createTask({
      title: "Create PR routes missing handlers",
      description: "Missing /api/tasks/:id/pr/options and /api/tasks/:id/pr/preflight and /api/tasks/:id/pr/generate-metadata",
      column: "todo",
    });
    await fx.store.archiveTask(canonical.id, { cleanup: false });
    const incoming = await fx.store.createTask({
      title: "Missing handlers for create PR routes",
      description: "GET /api/tasks/:id/pr/options and GET /api/tasks/:id/pr/preflight and POST /api/tasks/:id/pr/generate-metadata all fail",
    });

    await (fx.triage as any).finalizeApprovedTask(incoming, basePrompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(incoming.id);
    expect(updated.column).toBe("todo");
    expect(updated.sourceMetadata?.nearDuplicateOf).toBeFalsy();
    const flaggedActivity = await fx.store.getActivityLog({ type: "task:near-duplicate-flagged", limit: 20 });
    expect(flaggedActivity.some((entry) => entry.taskId === incoming.id)).toBe(false);
  });

  it("does not archive generic file overlap only", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    await fx.store.createTask({
      title: "Fix PR comments pagination",
      description: "Touch register-git-github.ts pagination only",
      column: "todo",
    });
    const incoming = await fx.store.createTask({
      title: "Add PR merge auto-rebase option",
      description: "Touch register-git-github.ts merge behavior only",
    });

    await (fx.triage as any).finalizeApprovedTask(incoming, basePrompt, await fx.store.getSettings(), {});
    const updated = await fx.store.getTask(incoming.id);
    expect(updated.column).toBe("todo");
  });

  it("does not archive when candidate is older than window", async () => {
    vi.useFakeTimers();
    const fx = await createFixture();
    fixtures.push(fx);

    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    await fx.store.createTask({
      title: "Create PR routes missing handlers",
      description: "Missing /api/tasks/:id/pr/options and /api/tasks/:id/pr/preflight and /api/tasks/:id/pr/generate-metadata",
      column: "todo",
    });

    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    const incoming = await fx.store.createTask({
      title: "Missing handlers for create PR routes",
      description: "GET /api/tasks/:id/pr/options and GET /api/tasks/:id/pr/preflight and POST /api/tasks/:id/pr/generate-metadata all fail",
    });
    await (fx.triage as any).finalizeApprovedTask(incoming, basePrompt, await fx.store.getSettings(), {});
    const updated = await fx.store.getTask(incoming.id);
    expect(updated.column).toBe("todo");
    vi.useRealTimers();
  });

  it("fails open when extractor throws", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const incoming = await fx.store.createTask({
      title: "Missing handlers for create PR routes",
      description: "GET /api/tasks/:id/pr/options and GET /api/tasks/:id/pr/preflight and POST /api/tasks/:id/pr/generate-metadata all fail",
    });
    vi.spyOn(core, "extractIntentSignature").mockImplementation(() => {
      throw new Error("boom");
    });

    await (fx.triage as any).finalizeApprovedTask(incoming, basePrompt, await fx.store.getSettings(), {});
    const updated = await fx.store.getTask(incoming.id);
    expect(updated.column).toBe("todo");
  });

  it("does not archive older task when newer candidate exists", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const older = await fx.store.createTask({
      title: "Create PR routes missing handlers",
      description: "Missing /api/tasks/:id/pr/options and /api/tasks/:id/pr/preflight and /api/tasks/:id/pr/generate-metadata",
    });
    const newer = await fx.store.createTask({
      title: "Missing handlers for create PR routes",
      description: "GET /api/tasks/:id/pr/options and GET /api/tasks/:id/pr/preflight and POST /api/tasks/:id/pr/generate-metadata all fail",
      column: "todo",
    });

    await (fx.triage as any).finalizeApprovedTask(older, basePrompt, await fx.store.getSettings(), {});

    const updatedOlder = await fx.store.getTask(older.id);
    expect(updatedOlder.column).not.toBe("archived");
    expect(updatedOlder.column).toBe("todo");
    const updatedNewer = await fx.store.getTask(newer.id);
    expect(updatedNewer.column).toBe("todo");
  });

  it("does not auto-archive siblings when both near-duplicates finalize in the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));

    const fx = await createFixture();
    fixtures.push(fx);

    const first = await fx.store.createTask({
      title: "Create PR routes missing handlers",
      description: "Missing /api/tasks/:id/pr/options and /api/tasks/:id/pr/preflight and /api/tasks/:id/pr/generate-metadata",
    });
    const second = await fx.store.createTask({
      title: "Missing handlers for create PR routes",
      description: "GET /api/tasks/:id/pr/options and GET /api/tasks/:id/pr/preflight and POST /api/tasks/:id/pr/generate-metadata all fail",
    });

    const settings = await fx.store.getSettings();
    await Promise.all([
      (fx.triage as any).finalizeApprovedTask(first, basePrompt, settings, {}),
      (fx.triage as any).finalizeApprovedTask(second, basePrompt, settings, {}),
    ]);

    const refreshed = await fx.store.listTasks({ includeArchived: true });
    const archived = refreshed.filter((task) => task.id === first.id || task.id === second.id).filter((task) => task.column === "archived");
    expect(archived.length).toBe(0);
    vi.useRealTimers();
  });
});
