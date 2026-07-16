import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { hasGit, hasPg, makeReliabilityFixture, type ReliabilityFixture } from "./_helpers.js";

const FULL_SPEC = `# Task: FN-7000 - Example\n\n## Mission\nThis spec mentions duplicate handling, but it is not a redirect marker.\n`;

function duplicateStub(canonicalId: string): string {
  return `DUPLICATE: ${canonicalId}\n`;
}

async function createPromptTask(
  fx: ReliabilityFixture,
  input: { id: string; column: "triage" | "todo" | "in-review"; title?: string; prompt: string },
) {
  /*
  FNXC:ExplicitDuplicateMarkerSweep 2026-07-16-11:25:
  The production marker parser intentionally accepts only canonical FN-#### ids.
  Each test configures the PG fixture's taskPrefix to FN so allocated ids produce
  a valid marker instead of DUPLICATE: KB-### and genuinely exercise deletion.
  */
  const task = await fx.store.createTask({
    title: input.title ?? input.id,
    description: `${input.id} description`,
  });
  if (input.column !== "triage") {
    await fx.store.moveTask(task.id, input.column);
  }
  const taskDir = join(fx.rootDir, ".fusion", "tasks", task.id);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "PROMPT.md"), input.prompt, "utf-8");
  return task;
}

const canRun = hasGit && hasPg;
(canRun ? describe : describe.skip)("reliability interactions: explicit duplicate marker sweep", () => {
  const fixtures: ReliabilityFixture[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (fixtures.length) {
      await fixtures.pop()!.cleanup();
    }
  });

  it("resolves an FN-5217-style stuck marker task during maintenance", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5217", column: "triage", prompt: duplicateStub(canonical.id) });

    await (fx.manager as any).runMaintenance();

    await expect(fx.store.getTask(duplicate.id)).rejects.toThrow(`Task ${duplicate.id} not found`);
    const softDeletedDuplicate = await fx.store.getTask(duplicate.id, { includeDeleted: true });
    expect(softDeletedDuplicate.deletedAt).toEqual(expect.any(String));
    const liveTasks = await fx.store.listTasks({ includeArchived: false });
    expect(liveTasks.map((task) => task.id)).not.toContain(duplicate.id);
    expect((await fx.store.getTask(canonical.id)).column).toBe("todo");
    const activity = await fx.store.getActivityLog({ type: "task:auto-archived-duplicate", limit: 20 });
    expect(activity.find((entry) => entry.taskId === duplicate.id)).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ canonicalTaskId: canonical.id, source: "explicit-marker-sweep" }),
      }),
    );
  });

  it("does not disturb unrelated in-review tasks when autoMerge is false", async () => {
    const fx = await makeReliabilityFixture({ settings: { autoMerge: false, taskPrefix: "FN" } });
    fixtures.push(fx);

    await fx.store.updateTask(fx.task.id, {
      status: "failed",
      branch: undefined,
      worktree: undefined,
    });
    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    await createPromptTask(fx, { id: "FN-5217", column: "triage", prompt: duplicateStub(canonical.id) });

    await (fx.manager as any).runMaintenance();

    const untouched = await fx.store.getTask(fx.task.id);
    expect(untouched.column).toBe("in-review");
    expect(untouched.status).toBe("failed");
  });

  it("leaves marker tasks alone when the canonical target is missing", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN" } });
    fixtures.push(fx);

    const duplicate = await createPromptTask(fx, { id: "FN-5301", column: "triage", prompt: "DUPLICATE: FN-9999\n" });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    expect((await fx.store.getTask(duplicate.id)).column).toBe("triage");
    const activity = await fx.store.getActivityLog({ type: "task:auto-archived-duplicate", limit: 20 });
    expect(activity.find((entry) => entry.taskId === duplicate.id)).toBeUndefined();
  });

  it("leaves full specs untouched", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN" } });
    fixtures.push(fx);

    const duplicate = await createPromptTask(fx, { id: "FN-5302", column: "todo", prompt: FULL_SPEC });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    expect((await fx.store.getTask(duplicate.id)).column).toBe("todo");
  });

  it("honors the disable flag", async () => {
    const fx = await makeReliabilityFixture({ settings: { resolveExplicitDuplicateMarkerEnabled: false, taskPrefix: "FN" } as never });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5303", column: "triage", prompt: duplicateStub(canonical.id) });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    expect((await fx.store.getTask(duplicate.id)).column).toBe("triage");
  });

  it("caps work at 50 tasks per sweep", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const ids: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const task = await createPromptTask(fx, {
        id: `FN-${6000 + index}`,
        column: index % 2 === 0 ? "triage" : "todo",
        prompt: duplicateStub(canonical.id),
      });
      ids.push(task.id);
    }

    expect(await (fx.manager as any).resolveExplicitDuplicateMarkerTasks()).toBe(50);
    const remainingAfterFirst = await fx.store.listTasks({ includeArchived: false });
    expect(remainingAfterFirst.filter((task) => ids.includes(task.id))).toHaveLength(10);

    expect(await (fx.manager as any).resolveExplicitDuplicateMarkerTasks()).toBe(10);
    const remainingAfterSecond = await fx.store.listTasks({ includeArchived: false });
    expect(remainingAfterSecond.filter((task) => ids.includes(task.id))).toHaveLength(0);
  }, 20_000);

  it("fails open when one delete throws and continues processing later tasks", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const first = await createPromptTask(fx, { id: "FN-5304", column: "triage", prompt: duplicateStub(canonical.id) });
    const second = await createPromptTask(fx, { id: "FN-5305", column: "triage", prompt: duplicateStub(canonical.id) });

    const originalDeleteTask = fx.store.deleteTask.bind(fx.store);
    const deleteSpy = vi.spyOn(fx.store, "deleteTask").mockImplementation(async (taskId, options) => {
      if (taskId === first.id) {
        throw new Error("boom");
      }
      return await originalDeleteTask(taskId, options as never);
    });

    expect(await (fx.manager as any).resolveExplicitDuplicateMarkerTasks()).toBe(1);
    expect(deleteSpy).toHaveBeenCalled();
    expect((await fx.store.getTask(first.id)).column).toBe("triage");
    await expect(fx.store.getTask(second.id)).rejects.toThrow(`Task ${second.id} not found`);
  });
});
