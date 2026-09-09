import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { hasGit, hasPg, makeReliabilityFixture, type ReliabilityFixture } from "./_helpers.js";

const FULL_SPEC = `# Task: FN-7000 - Example\n\n## Mission\nThis spec mentions duplicate handling, but it is not a redirect marker.\n`;

function duplicateStub(canonicalId: string): string {
  return `DUPLICATE: ${canonicalId}\n`;
}

async function createPromptTask(
  fx: ReliabilityFixture,
  input: { id: string; column: "triage" | "todo" | "in-review"; title?: string; prompt: string; sourceType?: "api" | "dashboard_ui" },
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
    source: input.sourceType ? { sourceType: input.sourceType } : undefined,
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
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5217", column: "triage", prompt: duplicateStub(canonical.id) });

    await (fx.manager as any).runMaintenance();

    const parkedDuplicate = await fx.store.getTask(duplicate.id);
    expect(parkedDuplicate).toMatchObject({ paused: true, pausedReason: "duplicate-decision-required", sourceMetadata: expect.objectContaining({ nearDuplicateOf: canonical.id, duplicateSource: "triage-marker" }) });
    const liveTasks = await fx.store.listTasks({ includeArchived: false });
    expect(liveTasks.map((task) => task.id)).toContain(duplicate.id);
    expect((await fx.store.getTask(canonical.id)).column).toBe("todo");
    const activity = await fx.store.getActivityLog({ type: "task:near-duplicate-flagged", limit: 20 });
    expect(activity.find((entry) => entry.taskId === duplicate.id)).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ canonicalTaskId: canonical.id, source: "triage-marker-flagged" }),
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

  it.each(["missing", "done", "archived", "soft-deleted"] as const)("cleans an inactive %s canonical marker instead of parking a hidden decision", async (state) => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);

    let canonicalId = "FN-9999";
    if (state !== "missing") {
      const canonical = await fx.store.createTask({ title: "Inactive canonical", description: "canonical", column: state === "soft-deleted" ? "triage" : state });
      canonicalId = canonical.id;
      if (state === "soft-deleted") {
        await fx.store.deleteTask(canonical.id, { removeLineageReferences: true });
      }
    }
    const duplicate = await createPromptTask(fx, { id: "FN-5301", column: "triage", prompt: duplicateStub(canonicalId) });
    const promptPath = join(fx.rootDir, ".fusion", "tasks", duplicate.id, "PROMPT.md");

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    const updated = await fx.store.getTask(duplicate.id);
    expect(updated.paused).not.toBe(true);
    expect(updated.pausedReason ?? null).toBeNull();
    // needs-replan (not null) so the card cannot look planning-finished without PROMPT
    expect(updated.status).toBe("needs-replan");
    expect(updated.sourceMetadata).toEqual(expect.objectContaining({
      nearDuplicateOf: canonicalId,
      nearDuplicateDismissed: true,
      duplicateSource: "triage-marker",
    }));
    expect(existsSync(promptPath)).toBe(false);
    expect(updated.log?.some((entry) =>
      entry.action === "Duplicate marker cleared for re-specification"
      && String(entry.outcome ?? "").includes(canonicalId),
    )).toBe(true);
  });

  it.each([
    ["dashboard user", "dashboard_ui", "needs-replan"],
    ["programmatic source", "api", "needs-replan"],
  ] as const)("handles a repeated inactive marker from a %s according to provenance", async (_label, sourceType, expectedStatus) => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Completed canonical", description: "canonical", column: "done" });
    const duplicate = await createPromptTask(fx, { id: "FN-5302", column: "triage", prompt: duplicateStub(canonical.id), sourceType });
    await fx.store.updateTask(duplicate.id, {
      sourceMetadataPatch: {
        nearDuplicateOf: canonical.id,
        duplicateSource: "triage-marker",
        nearDuplicateDismissed: true,
        duplicateMarkerClearCount: 1,
      },
    });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    const updated = await fx.store.getTask(duplicate.id);
    expect(updated.status).toBe(expectedStatus);
    expect(updated.error ?? null).toBeNull();
    expect(updated.sourceMetadata).toEqual(expect.objectContaining({ duplicateMarkerClearCount: 2 }));
  });

  it.each([
    ["user pause", { userPaused: true, paused: true, pausedReason: "manual" }],
    ["implicit user pause", { paused: true, pausedReason: null }],
    ["unrelated pause", { paused: true, pausedReason: "awaiting-approval" }],
  ])("preserves a %s while an inactive marker is encountered", async (_label, pause) => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);
    const duplicate = await createPromptTask(fx, { id: "FN-5301", column: "triage", prompt: duplicateStub("FN-9999") });
    await fx.store.updateTask(duplicate.id, pause);
    const promptPath = join(fx.rootDir, ".fusion", "tasks", duplicate.id, "PROMPT.md");

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    const updated = await fx.store.getTask(duplicate.id);
    expect(updated.paused).toBe(true);
    expect(updated.pausedReason ?? null).toBe(pause.pausedReason ?? null);
    expect(existsSync(promptPath)).toBe(true);
  });

  it("does not re-pause a same-canonical Keep acknowledgement during maintenance", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5302", column: "triage", prompt: duplicateStub(canonical.id) });
    const promptPath = join(fx.rootDir, ".fusion", "tasks", duplicate.id, "PROMPT.md");
    await fx.store.updateTask(duplicate.id, {
      sourceMetadataPatch: { nearDuplicateOf: canonical.id.toLowerCase(), duplicateSource: "triage-marker", nearDuplicateDismissed: true },
    });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    const updated = await fx.store.getTask(duplicate.id);
    expect(updated.paused).not.toBe(true);
    expect(updated.pausedReason ?? null).toBeNull();
    expect(updated.status).toBe("needs-replan");
    expect(updated.sourceMetadata).toEqual(expect.objectContaining({
      nearDuplicateOf: canonical.id,
      nearDuplicateDismissed: true,
    }));
    expect(existsSync(promptPath)).toBe(false);
  });

  it("still prompts when a marker names a different active canonical", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);

    const originalCanonical = await fx.store.createTask({ title: "Original canonical", description: "original", column: "todo" });
    const canonical = await fx.store.createTask({ title: "New canonical", description: "new", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5303", column: "triage", prompt: duplicateStub(canonical.id) });
    await fx.store.updateTask(duplicate.id, {
      sourceMetadataPatch: { nearDuplicateOf: originalCanonical.id, duplicateSource: "triage-marker", nearDuplicateDismissed: true },
    });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    expect(await fx.store.getTask(duplicate.id)).toMatchObject({
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadata: expect.objectContaining({ nearDuplicateOf: canonical.id, nearDuplicateDismissed: false }),
    });
  });

  it("preserves a user pause while cleaning an acknowledged marker", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "prompt" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5304", column: "triage", prompt: duplicateStub(canonical.id) });
    const promptPath = join(fx.rootDir, ".fusion", "tasks", duplicate.id, "PROMPT.md");
    await fx.store.updateTask(duplicate.id, {
      paused: true,
      pausedReason: "manual",
      sourceMetadataPatch: { nearDuplicateOf: canonical.id, duplicateSource: "triage-marker", nearDuplicateDismissed: true },
    });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    expect(await fx.store.getTask(duplicate.id)).toMatchObject({ paused: true, pausedReason: "manual" });
    expect(existsSync(promptPath)).toBe(true);
  });

  it("leaves full specs untouched", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "delete" } });
    fixtures.push(fx);

    const duplicate = await createPromptTask(fx, { id: "FN-5302", column: "todo", prompt: FULL_SPEC });

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    expect((await fx.store.getTask(duplicate.id)).column).toBe("todo");
  });

  it("honors the disable flag", async () => {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-21:45 (this guard could not fire):
    `triageDuplicateResolution: "delete"` is REQUIRED for this case to mean anything. Without it the
    sweep has no resolution action to take, so the duplicate survives whether the disable flag is
    honoured or ignored — the assertion held for a reason unrelated to the flag. Proven by mutation:
    forcing `enabled = true` in resolveExplicitDuplicateMarkerTasks left all 16 cases green. With the
    resolution mode set, that same mutation deletes the duplicate and this case fails.
    */
    const fx = await makeReliabilityFixture({ settings: { resolveExplicitDuplicateMarkerEnabled: false, taskPrefix: "FN", triageDuplicateResolution: "delete" } as never });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const duplicate = await createPromptTask(fx, { id: "FN-5303", column: "todo", prompt: duplicateStub(canonical.id) });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-21:30:
    Assert the card DID NOT MOVE, rather than that it sits in a named column. The invariant this
    case owns is "the disable flag stops the sweep"; the column id was incidental, and pinning
    `triage` broke it post-U11 (that column is no longer declared, so the seed lands in the merged
    Planning column `todo`). Reading the column back BEFORE the sweep also means this cannot pass
    because the seed happened to land where the assertion looked.
    */
    const columnBefore = (await fx.store.getTask(duplicate.id)).column;

    await (fx.manager as any).resolveExplicitDuplicateMarkerTasks();

    // Survives at all (the flag blocked the delete) AND did not move.
    expect((await fx.store.getTask(duplicate.id)).column).toBe(columnBefore);
  });

  it("caps work at 50 tasks per sweep", async () => {
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "delete" } });
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
    const fx = await makeReliabilityFixture({ settings: { taskPrefix: "FN", triageDuplicateResolution: "delete" } });
    fixtures.push(fx);

    const canonical = await fx.store.createTask({ title: "Canonical", description: "canonical", column: "todo" });
    const first = await createPromptTask(fx, { id: "FN-5304", column: "todo", prompt: duplicateStub(canonical.id) });
    const second = await createPromptTask(fx, { id: "FN-5305", column: "todo", prompt: duplicateStub(canonical.id) });
    // Same reason as the disable-flag case: what matters is that `first` SURVIVES the thrown
    // delete, not which column it sits in.
    const firstColumnBefore = (await fx.store.getTask(first.id)).column;

    const originalDeleteTask = fx.store.deleteTask.bind(fx.store);
    const deleteSpy = vi.spyOn(fx.store, "deleteTask").mockImplementation(async (taskId, options) => {
      if (taskId === first.id) {
        throw new Error("boom");
      }
      return await originalDeleteTask(taskId, options as never);
    });

    expect(await (fx.manager as any).resolveExplicitDuplicateMarkerTasks()).toBe(1);
    expect(deleteSpy).toHaveBeenCalled();
    expect((await fx.store.getTask(first.id)).column).toBe(firstColumnBefore);
    await expect(fx.store.getTask(second.id)).rejects.toThrow(`Task ${second.id} not found`);
  });
});
