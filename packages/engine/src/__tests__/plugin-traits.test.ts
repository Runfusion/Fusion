// @vitest-environment node
//
// PLUGIN-CONTRIBUTED TRAITS SUITE (U8, R6/R15/R22, KTD-2/KTD-7).
//
// Asserts against REAL engine wiring per the branch-group dead-wiring lesson:
//   - real TaskStore (in-memory sqlite) with the workflowColumns flag ON,
//   - real core TraitRegistry (fresh per test) + built-ins,
//   - real PluginLoader/PluginStore loading a JSON plugin module that declares
//     `traits`,
//   - real plugin-trait adapter (registration / gate eval / degrade / dependents).
//
// No engine methods are mocked. The only injected fake is the custom-node
// RUNNER (the prompt-session/script machinery), which is the documented seam the
// executor wires — we substitute a deterministic verdict producer so the test
// stays fast and offline.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  TaskStore,
  PluginStore,
  PluginLoader,
  getTraitRegistry,
  __resetTraitRegistryForTests,
  registerBuiltinTraits,
  registerDefaultWorkflowHooks,
  __resetDefaultWorkflowHooksForTests,
  validatePluginTraitContribution,
  type WorkflowIr,
  type PluginTraitContribution,
} from "@fusion/core";
import {
  registerPluginTraits,
  degradePluginTraits,
  findLivePluginTraitDependents,
  evaluatePluginGate,
  pluginTraitRegistryId,
  PluginTraitHasDependentsError,
} from "../plugin-trait-adapter.js";
import type { WorkflowCustomNodeRunner } from "../workflow-node-handlers.js";
import type { WorkflowNodeResult } from "../workflow-graph-executor.js";

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "ignore" });
}

/** Fresh registry with built-ins + default-workflow hooks re-wired (so the
 *  default-workflow move-effect hooks aren't degraded to no-ops mid-suite). */
function freshRegistry(): void {
  __resetTraitRegistryForTests();
  __resetDefaultWorkflowHooksForTests();
  registerBuiltinTraits();
  registerDefaultWorkflowHooks();
}

/** Raw column placement (bypasses adjacency validation for setup). */
function setColumn(store: TaskStore, taskId: string, column: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare('UPDATE tasks SET "column" = ?, "columnMovedAt" = ? WHERE id = ?').run(
    column,
    new Date().toISOString(),
    taskId,
  );
}

function setSelection(store: TaskStore, taskId: string, workflowId: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare(
    `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
     VALUES (?, ?, '[]', ?)
     ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId, updatedAt = excluded.updatedAt`,
  ).run(taskId, workflowId, new Date().toISOString());
}

function readTransitionPending(store: TaskStore, taskId: string): string | null {
  const db = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
  const row = db.prepare("SELECT transitionPending FROM tasks WHERE id = ?").get(taskId) as
    | { transitionPending: string | null }
    | undefined;
  return row?.transitionPending ?? null;
}

/**
 * A custom v2 workflow with three ordered columns. `gate-col` carries the given
 * plugin trait id; order-derived adjacency lets a card move
 * `intake-col → gate-col`.
 */
function customWorkflowIr(pluginTraitId: string, opts?: { traitConfig?: Record<string, unknown> }): WorkflowIr {
  return {
    version: "v2",
    name: "Custom",
    columns: [
      { id: "intake-col", name: "Intake", traits: [{ trait: "intake" }] },
      {
        id: "gate-col",
        name: "Gate",
        traits: [{ trait: pluginTraitId, config: opts?.traitConfig }],
      },
      { id: "done-col", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "intake-col" },
      { id: "end", kind: "end", column: "done-col" },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

const PASS_RUNNER: WorkflowCustomNodeRunner = async (): Promise<WorkflowNodeResult> => ({
  outcome: "success",
  value: "passed",
});
const FAIL_RUNNER: WorkflowCustomNodeRunner = async (): Promise<WorkflowNodeResult> => ({
  outcome: "failure",
  value: "blocked",
});

describe("U8 plugin trait contribution validation (R22, schemaVersion)", () => {
  it("rejects a malformed trait manifest (missing schemaVersion / name)", () => {
    const errors = validatePluginTraitContribution({ traitId: "x" });
    expect(errors.some((e) => e.includes("schemaVersion is required"))).toBe(true);
    expect(errors.some((e) => e.includes("name is required"))).toBe(true);
  });

  it("rejects a sync `guard` hook key (built-in-only, R22)", () => {
    const errors = validatePluginTraitContribution({
      traitId: "g",
      name: "G",
      schemaVersion: 1,
      hooks: { guard: true },
    });
    expect(errors.some((e) => e.includes("hooks.guard"))).toBe(true);
  });

  it("rejects a restricted flag (complete / archived, R22)", () => {
    const completeErr = validatePluginTraitContribution({
      traitId: "c",
      name: "C",
      schemaVersion: 1,
      flags: { complete: true },
    });
    expect(completeErr.some((e) => e.includes("flags.complete"))).toBe(true);

    const archivedErr = validatePluginTraitContribution({
      traitId: "a",
      name: "A",
      schemaVersion: 1,
      flags: { archived: true },
    });
    expect(archivedErr.some((e) => e.includes("flags.archived"))).toBe(true);
  });

  it("rejects a wrong schemaVersion (versioned extension contract)", () => {
    const errors = validatePluginTraitContribution({ traitId: "v", name: "V", schemaVersion: 2 as unknown as 1 });
    expect(errors.some((e) => e.includes("schemaVersion must be 1"))).toBe(true);
  });

  it("accepts a valid async-only gate contribution", () => {
    const errors = validatePluginTraitContribution({
      traitId: "approval",
      name: "Approval gate",
      schemaVersion: 1,
      flags: { gate: true },
      hooks: { gate: { mode: "prompt", prompt: "Approve?", gateMode: "blocking" } },
    });
    expect(errors).toEqual([]);
  });
});

describe("U8 registry resolution (valid trait resolves like a built-in)", () => {
  beforeEach(() => {
    freshRegistry();
  });
  afterEach(() => {
    __resetTraitRegistryForTests();
  });

  it("registers a plugin trait under a plugin-namespaced id and resolves through the same lookup", () => {
    const registry = getTraitRegistry();
    const contribution: PluginTraitContribution = {
      traitId: "approval",
      name: "Approval gate",
      schemaVersion: 1,
      flags: { gate: true },
      hooks: { gate: { mode: "prompt", prompt: "Approve?", gateMode: "blocking" } },
    };
    const ids = registerPluginTraits({ registry, pluginId: "gate-plugin", contributions: [contribution], runCustomNode: PASS_RUNNER });
    const id = pluginTraitRegistryId("gate-plugin", "approval");
    expect(ids).toEqual([id]);

    // Same lookup path as a built-in.
    const def = registry.getTrait(id);
    expect(def?.flags.gate).toBe(true);
    expect(def?.builtin).toBeFalsy();
    // Built-in still resolvable through the same registry.
    expect(registry.getTrait("complete")?.flags.complete).toBe(true);

    // The gate hook impl is registered (not a missing-impl degrade).
    const resolved = registry.resolveTraitHook(id, "gate");
    expect(resolved.impl).toBeTypeOf("function");
    expect(resolved.warning).toBeUndefined();
  });

  it("registry rejects a restricted-flag plugin trait as a backstop (R22)", () => {
    const registry = getTraitRegistry();
    // The adapter builds a non-builtin definition; the registry enforces R22.
    const bad: PluginTraitContribution = {
      traitId: "sneaky",
      name: "Sneaky",
      schemaVersion: 1,
      // @ts-expect-error — restricted flag deliberately set to prove the backstop.
      flags: { complete: true },
    };
    expect(() =>
      registerPluginTraits({ registry, pluginId: "p", contributions: [bad], runCustomNode: PASS_RUNNER }),
    ).toThrow(/restricted flag/i);
  });
});

describe("U8 gate evaluation (blocking fails closed; advisory allows)", () => {
  it("blocking gate: a failure verdict does not allow", async () => {
    const result = await evaluatePluginGate({
      traitRegistryId: "plugin:gate-plugin:approval",
      descriptor: { mode: "prompt", prompt: "Approve?", gateMode: "blocking" },
      task: { id: "T1" } as never,
      runCustomNode: FAIL_RUNNER,
    });
    expect(result.outcome).toBe("failure");
  });

  it("blocking gate: a pass verdict allows", async () => {
    const result = await evaluatePluginGate({
      traitRegistryId: "plugin:gate-plugin:approval",
      descriptor: { mode: "prompt", prompt: "Approve?", gateMode: "blocking" },
      task: { id: "T1" } as never,
      runCustomNode: PASS_RUNNER,
    });
    expect(result.outcome).toBe("success");
  });

  it("advisory gate: the handler reports the raw verdict (store layer record-and-allows)", async () => {
    // evaluatePluginGate returns the raw runner outcome; the advisory
    // "record-and-allow" decision is made at the store guard (see the store
    // re-check suite below, which proves an advisory column move commits).
    const result = await evaluatePluginGate({
      traitRegistryId: "plugin:gate-plugin:approval",
      descriptor: { mode: "prompt", prompt: "FYI", gateMode: "advisory" },
      task: { id: "T1" } as never,
      runCustomNode: FAIL_RUNNER,
    });
    expect(result.outcome).toBe("failure");
  });
});

describe("U8 store gate re-check (pre-evaluated verdict, KTD-2)", () => {
  let rootDir = "";
  let store: TaskStore;
  const gateTraitId = pluginTraitRegistryId("gate-plugin", "approval");

  beforeEach(async () => {
    freshRegistry();
    const registry = getTraitRegistry();
    registry.register({
      id: gateTraitId,
      name: "Approval gate",
      flags: { gate: true },
      hooks: { gate: true },
      builtin: false,
    });
    // A LIVE gate hook impl (so the store enforces the recorded verdict rather
    // than treating the gate as a degraded/passive no-op).
    registry.registerTraitHookImpl(gateTraitId, "gate", () => undefined);

    rootDir = mkdtempSync(join(tmpdir(), "u8-plugin-traits-"));
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
    __resetTraitRegistryForTests();
    vi.clearAllMocks();
  });

  async function seedCardInGateWorkflow(config?: Record<string, unknown>): Promise<string> {
    const def = await store.createWorkflowDefinition({
      name: "Gate WF",
      ir: customWorkflowIr(gateTraitId, { traitConfig: config }),
    });
    const task = await store.createTask({ description: "card" });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "intake-col");
    return task.id;
  }

  it("blocking gate with NO recorded verdict rejects the move (fail closed)", async () => {
    const id = await seedCardInGateWorkflow({ gateMode: "blocking" });
    await expect(
      store.moveTask(id, "gate-col", { moveSource: "user" }),
    ).rejects.toThrow(/has not been evaluated|did not pass/);
    expect((await store.getTask(id)).column).toBe("intake-col");
  });

  it("blocking gate with a recorded ALLOW verdict permits the move", async () => {
    const id = await seedCardInGateWorkflow({ gateMode: "blocking" });
    store.recordPluginGateVerdict(id, "gate-col", {
      traitId: gateTraitId,
      allow: true,
      gateMode: "blocking",
    });
    const moved = await store.moveTask(id, "gate-col", { moveSource: "user" });
    expect(moved.column).toBe("gate-col");
  });

  it("blocking gate with a recorded DENY verdict rejects the move (typed rejection)", async () => {
    const id = await seedCardInGateWorkflow({ gateMode: "blocking" });
    store.recordPluginGateVerdict(id, "gate-col", {
      traitId: gateTraitId,
      allow: false,
      gateMode: "blocking",
      detail: "reviewer rejected",
    });
    await expect(
      store.moveTask(id, "gate-col", { moveSource: "user" }),
    ).rejects.toThrow(/reviewer rejected/);
    expect((await store.getTask(id)).column).toBe("intake-col");
  });

  it("advisory gate allows the move even without a verdict (record-and-allow)", async () => {
    const id = await seedCardInGateWorkflow({ gateMode: "advisory" });
    const moved = await store.moveTask(id, "gate-col", { moveSource: "user" });
    expect(moved.column).toBe("gate-col");
  });

  it("engine-sourced move bypasses the plugin gate (KTD-9)", async () => {
    const id = await seedCardInGateWorkflow({ gateMode: "blocking" });
    // No verdict recorded; an engine move bypasses guards entirely.
    const moved = await store.moveTask(id, "gate-col", { moveSource: "engine" });
    expect(moved.column).toBe("gate-col");
  });
});

describe("U8 onEnter hook degradation (card stays, marker cleared, no wedge)", () => {
  let rootDir = "";
  let store: TaskStore;
  const traitId = pluginTraitRegistryId("notify-plugin", "boom");

  beforeEach(async () => {
    freshRegistry();
    // A plugin trait with an onEnter hook whose impl THROWS.
    const registry = getTraitRegistry();
    registry.register({
      id: traitId,
      name: "Boom",
      flags: { notify: true },
      hooks: { onEnter: true },
      builtin: false,
    });
    registry.registerTraitHookImpl(traitId, "onEnter", () => {
      throw new Error("plugin onEnter blew up");
    });

    rootDir = mkdtempSync(join(tmpdir(), "u8-onenter-"));
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
    __resetTraitRegistryForTests();
  });

  it("a throwing plugin onEnter does NOT strand the card or wedge the lock", async () => {
    // gate-col carries the throwing onEnter trait; move there, then verify a
    // subsequent move still succeeds (the lock was not wedged) and the
    // transitionPending marker did not stick.
    const def = await store.createWorkflowDefinition({
      name: "Boom WF",
      ir: customWorkflowIr(traitId),
    });
    const task = await store.createTask({ description: "card" });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "intake-col");

    // Degraded-not-stranded (KTD-2/R15): the move commits the column change in
    // its transaction; plugin post-commit hooks are isolated from the move's
    // success path (a throwing onEnter cannot fail the move, strand the card, or
    // wedge the lock). The card lands in gate-col regardless of the plugin hook.
    const moved = await store.moveTask(task.id, "gate-col", { moveSource: "user" });
    expect(moved.column).toBe("gate-col");

    // The marker was cleared post-commit — not left dangling.
    expect(readTransitionPending(store, task.id)).toBeNull();

    // The lock is not wedged: a follow-up move proceeds.
    const back = await store.moveTask(task.id, "intake-col", { moveSource: "user" });
    expect(back.column).toBe("intake-col");
  });
});

describe("Residual C: plugin onEnter/onExit are INVOKED on the post-commit path", () => {
  let rootDir = "";
  let store: TaskStore;
  const enterTrait = pluginTraitRegistryId("notify-plugin", "enter");
  const exitTrait = pluginTraitRegistryId("notify-plugin", "exit");
  let enterCalls = 0;
  let exitCalls = 0;

  beforeEach(async () => {
    freshRegistry();
    enterCalls = 0;
    exitCalls = 0;
    const registry = getTraitRegistry();
    registry.register({ id: enterTrait, name: "Enter", flags: { notify: true }, hooks: { onEnter: true }, builtin: false });
    registry.register({ id: exitTrait, name: "Exit", flags: { notify: true }, hooks: { onExit: true }, builtin: false });
    registry.registerTraitHookImpl(enterTrait, "onEnter", () => { enterCalls += 1; });
    registry.registerTraitHookImpl(exitTrait, "onExit", () => { exitCalls += 1; });

    rootDir = mkdtempSync(join(tmpdir(), "u8-cohooks-"));
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
    __resetTraitRegistryForTests();
  });

  it("onEnter fires for the to-column's plugin trait; onExit fires for the from-column's", async () => {
    // Workflow: intake-col(exit trait) → gate-col(enter trait) → done-col.
    const ir = {
      version: "v2",
      name: "CoHooks",
      columns: [
        { id: "intake-col", name: "Intake", traits: [{ trait: "intake" }, { trait: exitTrait }] },
        { id: "gate-col", name: "Gate", traits: [{ trait: enterTrait }] },
        { id: "done-col", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake-col" },
        { id: "end", kind: "end", column: "done-col" },
      ],
      edges: [{ from: "start", to: "end" }],
    } as WorkflowIr;
    const def = await store.createWorkflowDefinition({ name: "CoHooks", ir });
    const task = await store.createTask({ description: "card" });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "intake-col");

    const moved = await store.moveTask(task.id, "gate-col", { moveSource: "user" });
    expect(moved.column).toBe("gate-col");
    expect(enterCalls).toBe(1); // gate-col onEnter
    expect(exitCalls).toBe(1); // intake-col onExit
    // Marker cleared (no strand).
    expect(readTransitionPending(store, task.id)).toBeNull();
  });

  it("engine-sourced (bypassGuards) moves skip plugin hooks (KTD-9)", async () => {
    const ir = {
      version: "v2",
      name: "CoHooks2",
      columns: [
        { id: "intake-col", name: "Intake", traits: [{ trait: "intake" }] },
        { id: "gate-col", name: "Gate", traits: [{ trait: enterTrait }] },
        { id: "done-col", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "intake-col" },
        { id: "end", kind: "end", column: "done-col" },
      ],
      edges: [{ from: "start", to: "end" }],
    } as WorkflowIr;
    const def = await store.createWorkflowDefinition({ name: "CoHooks2", ir });
    const task = await store.createTask({ description: "card" });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "intake-col");

    await store.moveTask(task.id, "gate-col", { moveSource: "engine", bypassGuards: true });
    expect(enterCalls).toBe(0); // engine move bypasses trait effects
  });
});

describe("U8 plugin loader aggregation + disable/force-disable (KTD-7)", () => {
  let rootDir = "";
  let pluginStore: PluginStore;
  let loader: PluginLoader;
  let taskRoot = "";
  let store: TaskStore;

  const traitContribution: PluginTraitContribution = {
    traitId: "approval",
    name: "Approval gate",
    schemaVersion: 1,
    flags: { gate: true },
    hooks: { gate: { mode: "prompt", prompt: "Approve?", gateMode: "blocking" } },
  };
  const traitRegistryId = pluginTraitRegistryId("gate-plugin", "approval");

  beforeEach(async () => {
    freshRegistry();

    rootDir = mkdtempSync(join(tmpdir(), "u8-loader-"));
    pluginStore = new PluginStore(rootDir, { inMemoryDb: true, centralGlobalDir: rootDir });
    loader = new PluginLoader({ pluginStore, taskStore: { logActivity: vi.fn() } as never });
    await pluginStore.init();

    taskRoot = mkdtempSync(join(tmpdir(), "u8-loader-tasks-"));
    git(taskRoot, "init -b main");
    git(taskRoot, "config user.name 'Fusion'");
    git(taskRoot, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(taskRoot, "README.md"), "root\n");
    git(taskRoot, "add README.md");
    git(taskRoot, "commit -m init");
    store = new TaskStore(taskRoot, undefined, { inMemoryDb: false });
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  afterEach(async () => {
    try { store?.close(); } catch { /* ignore */ }
    if (taskRoot) rmSync(taskRoot, { recursive: true, force: true });
    const { rm } = await import("node:fs/promises");
    await rm(rootDir, { recursive: true, force: true });
    __resetTraitRegistryForTests();
  });

  async function loadGatePlugin(): Promise<void> {
    const pluginDir = join(rootDir, "plugins");
    await mkdir(pluginDir, { recursive: true });
    const plugin = {
      manifest: { id: "gate-plugin", name: "Gate Plugin", version: "1.0.0" },
      state: "installed",
      hooks: {},
      traits: [traitContribution],
    };
    const path = join(pluginDir, "gate-plugin.mjs");
    await writeFile(path, `const plugin = ${JSON.stringify(plugin, null, 2)}; export default plugin;`);
    await pluginStore.registerPlugin({ manifest: plugin.manifest, path });
    await loader.loadAllPlugins();
  }

  it("loader aggregates plugin trait contributions with ownership", async () => {
    await loadGatePlugin();
    const traits = loader.getPluginTraits();
    expect(traits).toHaveLength(1);
    expect(traits[0].pluginId).toBe("gate-plugin");
    expect(traits[0].trait.traitId).toBe("approval");
  });

  it("disable with cards in a plugin-trait column is BLOCKED with a typed dependents error", async () => {
    await loadGatePlugin();
    const registry = getTraitRegistry();
    registerPluginTraits({
      registry,
      pluginId: "gate-plugin",
      contributions: loader.getPluginTraits().map((t) => t.trait),
      runCustomNode: PASS_RUNNER,
    });

    // Seed a live card in a column using the plugin trait.
    const def = await store.createWorkflowDefinition({ name: "Gate WF", ir: customWorkflowIr(traitRegistryId) });
    const task = await store.createTask({ description: "card" });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "gate-col");

    const resolveIr = (taskId: string): WorkflowIr | undefined =>
      store.getTaskWorkflowSelection(taskId)?.workflowId === def.id ? def.ir : undefined;

    const dependents = await findLivePluginTraitDependents({
      store,
      resolveTaskWorkflowIr: resolveIr,
      pluginTraitIds: [traitRegistryId],
    });
    expect(dependents).toHaveLength(1);
    expect(dependents[0].taskId).toBe(task.id);
    expect(dependents[0].column).toBe("gate-col");

    // The typed error is the disable block (mirrors the built-in-workflow block).
    const err = new PluginTraitHasDependentsError("gate-plugin", dependents);
    expect(err.dependents).toHaveLength(1);
    expect(err.message).toContain("gate-plugin");
  });

  it("force-disable degrades the column to passive: hooks become no-ops, cards still movable", async () => {
    await loadGatePlugin();
    const registry = getTraitRegistry();
    registerPluginTraits({
      registry,
      pluginId: "gate-plugin",
      contributions: loader.getPluginTraits().map((t) => t.trait),
      runCustomNode: FAIL_RUNNER, // would block if still live
    });

    const def = await store.createWorkflowDefinition({ name: "Gate WF", ir: customWorkflowIr(traitRegistryId, { traitConfig: { gateMode: "blocking" } }) });
    const task = await store.createTask({ description: "card" });
    setSelection(store, task.id, def.id);
    setColumn(store, task.id, "intake-col");

    // Before degrade: the gate hook impl is registered (not a missing-impl no-op).
    expect(registry.resolveTraitHook(traitRegistryId, "gate").warning).toBeUndefined();

    // Force-disable: degrade the trait's hooks to no-ops.
    const degraded = degradePluginTraits(registry, [traitRegistryId]);
    expect(degraded).toContain(traitRegistryId);

    // The trait definition still resolves (column not bricked) but the hook is
    // now the degraded no-op + audit warning path.
    expect(registry.getTrait(traitRegistryId)).toBeDefined();
    const resolved = registry.resolveTraitHook(traitRegistryId, "gate");
    expect(resolved.warning?.kind).toBe("missing-hook-impl");

    // Card is still movable into the degraded column with NO recorded verdict:
    // the store guard sees the degraded (warning) gate and treats it as passive
    // (KTD-7 — cards remain movable). A live (non-degraded) blocking gate would
    // have rejected this move for lack of a verdict.
    const moved = await store.moveTask(task.id, "gate-col", { moveSource: "user" });
    expect(moved.column).toBe("gate-col");
  });
});
