import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractDeclaredSymbolsFromPrompt,
  hasOwnDeclaredSymbols,
  normalizeDeclaredSymbols,
  resolveCreateDeclaredSymbols,
  resolveTaskSymbolsForTask,
  resolveTaskSymbolsFromSources,
} from "../tasks/task-symbol-resolution.js";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../__test-utils__/pg-test-harness.js";
import { _createTaskInternalImpl } from "../task-store/task-creation.js";
import type { TaskStore } from "../store.js";

const prompt = "## Declared Symbols\n- `Pkg\\File.ts # Foo`\n- `pkg/file.ts#foo`\n\n## File Scope\n- `packages/core/src/store.ts`\n";

describe("task symbol declaration resolution", () => {
  it("normalizes, deduplicates, and extracts prompt declarations", () => {
    expect(extractDeclaredSymbolsFromPrompt(prompt)).toEqual([
      "Pkg\\File.ts # Foo",
      "pkg/file.ts#foo",
    ]);
    expect(normalizeDeclaredSymbols([" B#C ", "a#b", "b#c", ""])).toEqual([
      "a#b",
      "b#c",
    ]);
  });

  it("hydrates create declarations only when the property is absent", () => {
    expect(resolveCreateDeclaredSymbols({}, prompt)).toEqual(["pkg/file.ts#foo"]);
    expect(resolveCreateDeclaredSymbols({ declaredSymbols: [] }, prompt)).toBeUndefined();
    expect(resolveCreateDeclaredSymbols({ declaredSymbols: undefined }, prompt)).toBeUndefined();
    expect(resolveCreateDeclaredSymbols({ declaredSymbols: ["Raw#A"] }, prompt)).toEqual(["raw#a"]);
    expect(hasOwnDeclaredSymbols({ declaredSymbols: undefined })).toBe(true);
    expect(hasOwnDeclaredSymbols({})).toBe(false);
  });

  it("keeps offline prompt fallback separate from durable task resolution", () => {
    expect(resolveTaskSymbolsFromSources({ declaredSymbols: [], promptContent: prompt }))
      .toMatchObject({ resolvable: true, source: "prompt", symbols: ["pkg/file.ts#foo"] });
    expect(resolveTaskSymbolsForTask({ declaredSymbols: [] })).toEqual({
      resolvable: false,
      symbols: [],
      source: "none",
      reason: "empty",
    });
    expect(resolveTaskSymbolsForTask(null)).toEqual({
      resolvable: false,
      symbols: [],
      source: "none",
      reason: "missing-task",
    });
  });

  it("reports invalid-only declarations and never derives a symbol from File Scope", () => {
    expect(resolveTaskSymbolsFromSources({ declaredSymbols: [""] })).toEqual({
      resolvable: false,
      symbols: [],
      source: "declared",
      reason: "invalid-only",
    });
    expect(resolveTaskSymbolsFromSources({
      promptContent: "## File Scope\n- `packages/core/src/store.ts`",
    })).toMatchObject({ resolvable: false });
  });

});

/**
 * FNXC:SymbolLock 2026-07-31-11:00:
 * SQLite was removed from the runtime, so createTaskStoreTestHarness cannot
 * initialize a non-backend TaskStore. Exercise the retained file-task
 * constructor directly with its filesystem seam instead. This keeps the
 * declaration contract covered without reviving a removed SQLite runtime.
 */
describe("file-task constructor declared symbols", () => {
  it("persists normalized declarations through _createTaskInternalImpl", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-task-symbols-"));
    const created: unknown[] = [];
    const store = {
      backendMode: false,
      taskDir: (id: string) => join(root, id),
      maybeResolveTombstonedTaskId: async () => undefined,
      assertTaskIdAvailable: async () => undefined,
      atomicCreateTaskJson: async (_dir: string, task: unknown) => { created.push(task); },
      isWatching: false,
      generateSpecifiedPrompt: () => "",
      _maybeAutoArchiveSameAgentDuplicate: async () => undefined,
      emitTaskLifecycleEventSafely: () => undefined,
      invokeTaskCreatedHook: async () => undefined,
    } as unknown as TaskStore;

    try {
      expect(store.backendMode).toBe(false);
      const task = await _createTaskInternalImpl(
        store,
        { description: "file constructor declaration", declaredSymbols: ["Pkg\\File.ts#Foo"] },
        undefined,
        undefined,
        "FN-SYMBOL-FILE",
        { promptOverride: prompt, invokeTaskCreatedHook: false },
      );
      expect(task.declaredSymbols).toEqual(["pkg/file.ts#foo"]);
      expect(created).toEqual([task]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

pgDescribe("TaskStore task symbol declarations", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_task_symbols" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("persists normalized declarations and resolves durable task symbols", async () => {
    const h = await makeHarness();
    try {
      expect(h.store.backendMode).toBe(true);
      const task = await h.store.createTask({
        description: "symbol declaration task",
        declaredSymbols: ["Pkg/File.ts#Foo", "pkg\\file.ts#foo"],
      });
      expect((await h.store.getTask(task.id)).declaredSymbols).toEqual(["pkg/file.ts#foo"]);
      expect((await h.store.listTasks()).find((candidate) => candidate.id === task.id)?.declaredSymbols)
        .toEqual(["pkg/file.ts#foo"]);
      expect(await h.store.resolveTaskSymbols(task.id)).toEqual({
        resolvable: true,
        symbols: ["pkg/file.ts#foo"],
        source: "declared",
      });
      expect(await h.store.resolveTaskSymbolsForWorkItem({ taskId: task.id }))
        .toEqual(await h.store.resolveTaskSymbols(task.id));
      expect(await h.store.resolveTaskSymbols("missing-task")).toEqual({
        resolvable: false,
        symbols: [],
        source: "none",
        reason: "missing-task",
      });
    } finally {
      await teardown();
    }
  });

  it("applies create and update own-property rules without prompt re-reads", async () => {
    const h = await makeHarness();
    try {
      const absent = await h.store.createTaskWithReservedId(
        { description: "hydrate from prompt" },
        { taskId: "FN-SYMBOL-ABSENT", prompt },
      );
      expect(absent.declaredSymbols).toEqual(["pkg/file.ts#foo"]);

      const empty = await h.store.createTaskWithReservedId(
        { description: "explicit empty", declaredSymbols: [] },
        { taskId: "FN-SYMBOL-EMPTY", prompt },
      );
      const undefinedValue = await h.store.createTaskWithReservedId(
        { description: "explicit undefined", declaredSymbols: undefined },
        { taskId: "FN-SYMBOL-UNDEFINED", prompt },
      );
      const explicit = await h.store.createTaskWithReservedId(
        { description: "explicit declaration", declaredSymbols: ["Raw#A"] },
        { taskId: "FN-SYMBOL-EXPLICIT", prompt },
      );
      expect(empty.declaredSymbols).toBeUndefined();
      expect(undefinedValue.declaredSymbols).toBeUndefined();
      expect(explicit.declaredSymbols).toEqual(["raw#a"]);

      await h.store.updateTask(absent.id, { declaredSymbols: null });
      expect(await h.store.resolveTaskSymbols(absent.id)).toMatchObject({
        resolvable: false,
        reason: "empty",
      });
      await h.store.updateTask(absent.id, { declaredSymbols: undefined });
      await h.store.updateTask(absent.id, { declaredSymbols: [] });
      expect(await h.store.resolveTaskSymbols(absent.id)).toMatchObject({
        resolvable: false,
        reason: "empty",
      });
      await h.store.updateTask(absent.id, { prompt });
      expect(await h.store.resolveTaskSymbols(absent.id)).toEqual({
        resolvable: true,
        symbols: ["pkg/file.ts#foo"],
        source: "declared",
      });
    } finally {
      await teardown();
    }
  });

  it("retains declarations across archive and restore", async () => {
    const h = await makeHarness();
    try {
      const task = await h.store.createTask({
        description: "archived symbol declaration",
        declaredSymbols: ["Pkg/File.ts#Foo"],
      });
      await h.store.archiveTask(task.id);
      const restored = await h.store.unarchiveTask(task.id);
      expect(restored.declaredSymbols).toEqual(["pkg/file.ts#foo"]);
    } finally {
      await teardown();
    }
  });
});
