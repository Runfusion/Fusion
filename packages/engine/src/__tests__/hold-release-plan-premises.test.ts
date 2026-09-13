import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { admitTaskToWip } from "../execution/hold-release.js";
import { checkPlanPremises } from "../execution/plan-premise-check.js";

const roots: string[] = [];
const ir: WorkflowIr = {
  version: "v2", id: "test", name: "test",
  columns: [
    { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
  ],
  nodes: [], edges: [],
};

async function fixture(premise: string, fileText = "export const alphaUpdatesEnabled = true;") {
  const root = await mkdtemp(join(tmpdir(), "fusion-fn-375-"));
  roots.push(root);
  await writeFile(join(root, "App.tsx"), fileText);
  const task = {
    id: "FN-375-T", title: "planned", description: "planned", column: "todo", status: null,
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    prompt: `# Task\n\n## Plan Premises\n\n- ${premise}\n\n## Steps\n`,
  } as Task;
  const reserve = vi.fn(() => ({ release: vi.fn() }));
  const allocate = vi.fn(() => join(root, "worktree"));
  const moveTaskIf = vi.fn(async (_id: string, target: string, predicate: (live: Task) => boolean | Promise<boolean>, options?: { allocateWorktree?: (names: Set<string>) => string | null }) => {
    if (!(await predicate(task))) return { task, moved: false };
    options?.allocateWorktree?.(new Set());
    task.column = target;
    return { task, moved: true };
  });
  const store = {
    getRootDir: () => root,
    getSettings: vi.fn(async () => ({ maxConcurrent: 3 })),
    updateTaskAtomic: vi.fn(async (_id, mutate) => {
      const patch = await mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn(async (_id, message) => { task.log.push({ timestamp: new Date().toISOString(), message } as never); }),
    moveTaskIf,
  } as unknown as TaskStore;
  return { root, task, store, reserve, allocate, moveTaskIf };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("stateless plan premise release gate", () => {
  it("admits a true premise and preserves reservation/allocation", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task, names) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: true, task: { column: "doing" } });
    expect(f.reserve).toHaveBeenCalledOnce();
    expect(f.allocate).toHaveBeenCalledOnce();
  });

  it("replans a stale operator change before reserve, allocation, or move", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}', "export const footer = true;");
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: f.reserve, allocateWorktree: (_task, names) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-stale", detail: expect.stringContaining("alphaUpdatesEnabled") });
    expect(f.task).toMatchObject({ column: "todo", status: "needs-replan", error: null });
    expect(f.task.log.at(-1)?.message).toContain("alphaUpdatesEnabled");
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.moveTaskIf).not.toHaveBeenCalled();
  });

  it("fails closed for malformed contracts and unavailable reads", async () => {
    const invalid = await fixture('{"kind":"shell","path":"App.tsx"}');
    await expect(admitTaskToWip(invalid.store, { now: Date.now }, invalid.task, "doing", ir)).resolves.toMatchObject({ released: false, rejection: "plan-premise-invalid" });
    expect(invalid.task.status).toBe("needs-replan");

    const unavailable = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    (unavailable.store as unknown as { getRootDir(): string }).getRootDir = () => join(unavailable.root, "missing-root");
    await expect(admitTaskToWip(unavailable.store, { now: Date.now }, unavailable.task, "doing", ir)).resolves.toMatchObject({ released: false, rejection: "plan-premise-unavailable" });
    expect(unavailable.task).toMatchObject({ column: "todo", status: null });
  });

  it("rechecks the live premise after reservation and rejects a race", async () => {
    const f = await fixture('{"kind":"text-present","path":"App.tsx","literal":"alphaUpdatesEnabled"}');
    f.moveTaskIf.mockImplementationOnce(async (_id, _target, predicate) => {
      await writeFile(join(f.root, "App.tsx"), "export const footer = true;");
      await predicate(f.task);
      return { task: f.task, moved: false };
    });
    const reservationRelease = vi.fn();
    const result = await admitTaskToWip(f.store, { now: Date.now, reserveSlot: () => ({ release: reservationRelease }), allocateWorktree: (_task, names) => f.allocate(names) }, f.task, "doing", ir);
    expect(result).toMatchObject({ released: false, rejection: "plan-premise-stale" });
    expect(f.task).toMatchObject({ column: "todo", status: "needs-replan" });
    expect(reservationRelease).toHaveBeenCalledOnce();
    expect(f.allocate).not.toHaveBeenCalled();
  });

  it("requires regular files and detects a file replaced by a directory", async () => {
    const fileExists = await fixture('{"kind":"file-exists","path":"App.tsx"}');
    await expect(checkPlanPremises(fileExists.store, fileExists.task)).resolves.toEqual({ outcome: "satisfied" });
    await rm(join(fileExists.root, "App.tsx"));
    await mkdir(join(fileExists.root, "App.tsx"));
    await expect(checkPlanPremises(fileExists.store, fileExists.task)).resolves.toMatchObject({ outcome: "stale" });

    const textAbsent = await fixture('{"kind":"text-absent","path":"App.tsx","literal":"removedSetting"}');
    await expect(checkPlanPremises(textAbsent.store, textAbsent.task)).resolves.toEqual({ outcome: "satisfied" });
    await rm(join(textAbsent.root, "App.tsx"));
    await mkdir(join(textAbsent.root, "App.tsx"));
    await expect(checkPlanPremises(textAbsent.store, textAbsent.task)).resolves.toMatchObject({ outcome: "stale" });

    const absentPath = await fixture('{"kind":"file-absent","path":"App.tsx"}');
    await rm(join(absentPath.root, "App.tsx"));
    await mkdir(join(absentPath.root, "App.tsx"));
    await expect(checkPlanPremises(absentPath.store, absentPath.task)).resolves.toMatchObject({ outcome: "stale" });
  });

  it("rejects symlinks outside the project root as an invalid contract", async () => {
    const f = await fixture('{"kind":"file-exists","path":"outside"}');
    const outside = await mkdtemp(join(tmpdir(), "fusion-fn-375-outside-"));
    roots.push(outside);
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(f.root, "outside"));
    await expect(checkPlanPremises(f.store, f.task)).resolves.toMatchObject({ outcome: "invalid-contract" });
  });
});
