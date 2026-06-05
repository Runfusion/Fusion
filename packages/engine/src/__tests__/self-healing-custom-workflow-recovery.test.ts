// @vitest-environment node
//
// #1411: self-healing recovery/backward moves on CUSTOM workflows must pass
// `recoveryRehome: true` (not rely on `bypassGuards`, which skips trait guards
// but NOT order-derived column-graph adjacency). A custom workflow whose
// order-derived adjacency lacks the custom-column → todo edge would otherwise
// reject the recovery move and strand the card.
//
// This exercises a REAL TaskStore (flag-ON) so the in-lock adjacency check
// (resolveAllowedColumns) actually runs:
//   - a backward recovery move WITHOUT recoveryRehome (engine source +
//     bypassGuards) is rejected by adjacency, proving bypassGuards alone is
//     insufficient (the bug),
//   - the SAME move WITH recoveryRehome: true succeeds (the fix self-healing
//     now applies at its moveTask call sites).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { TaskStore, type WorkflowIr } from "@fusion/core";

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "ignore" });
}

function setColumn(store: TaskStore, taskId: string, column: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare('UPDATE tasks SET "column" = ?, "columnMovedAt" = ? WHERE id = ?').run(
    column,
    new Date().toISOString(),
    taskId,
  );
}

/**
 * A custom workflow whose linear order is intake → build → done. Its
 * order-derived adjacency has NO edge build → todo (todo is not even a column),
 * so a recovery move build → todo is only reachable via recoveryRehome.
 */
function customIr(): WorkflowIr {
  return {
    version: "v2",
    name: "linear-custom",
    columns: [
      { id: "intake", name: "intake", traits: [{ trait: "intake" }] },
      { id: "build", name: "build", traits: [] },
      { id: "done", name: "done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "intake" },
      { id: "work", kind: "prompt", column: "build", config: { prompt: "do" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "work", condition: "success" },
      { from: "work", to: "end", condition: "success" },
    ],
  } as WorkflowIr;
}

describe("#1411 self-healing recovery move on custom workflows", () => {
  let rootDir = "";
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-1411-"));
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m init");
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  afterEach(() => {
    try { store?.close(); } catch { /* ignore */ }
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function seedCardInBuild(): Promise<string> {
    const wf = await store.createWorkflowDefinition({ name: "linear-custom", ir: customIr() });
    const task = await store.createTask({ description: "stuck-in-build" });
    await store.selectTaskWorkflowAndReconcile(task.id, wf.id);
    setColumn(store, task.id, "build");
    expect((await store.getTask(task.id)).column).toBe("build");
    return task.id;
  }

  it("bypassGuards alone is rejected by order-derived adjacency (build → todo)", async () => {
    const id = await seedCardInBuild();
    let caught: unknown;
    try {
      // Mirrors a self-healing backward move BEFORE the fix: engine source +
      // bypassGuards, but no recoveryRehome. Adjacency (build → todo) has no edge.
      await store.moveTask(id, "todo", { moveSource: "engine", bypassGuards: true, preserveProgress: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((await store.getTask(id)).column).toBe("build");
  });

  it("recoveryRehome: true lets the recovery move reach todo (the fix)", async () => {
    const id = await seedCardInBuild();
    await store.moveTask(id, "todo", {
      moveSource: "engine",
      recoveryRehome: true,
      preserveProgress: true,
    });
    expect((await store.getTask(id)).column).toBe("todo");
  });

  it("recoveryRehome: true also reaches a terminal recovery target (archived)", async () => {
    const id = await seedCardInBuild();
    await store.moveTask(id, "archived", { moveSource: "engine", recoveryRehome: true });
    expect((await store.getTask(id)).column).toBe("archived");
  });
});
