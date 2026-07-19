import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
FNXC:CliTests 2026-07-04-13:50:
FN-7530 split this single test out of extension.test.ts. The whole-file exclude that FN-7447 applied to
extension.test.ts to quarantine this one dist-barrel recompilation case was collaterally dropping ~68 otherwise-stable
tests. Isolating it here lets extension.test.ts return to the default lane while this file (and only this file) carries
its own quarantine entry/deletion clock in lockstep with scripts/lib/test-quarantine.json. See that ledger entry and
packages/cli/vitest.config.ts for the current in/out-of-lane status and root-cause note.
*/

vi.mock("@fusion/core/gh-cli", () => ({
  isGhAvailable: vi.fn(() => true),
  isGhAuthenticated: vi.fn(() => true),
  runGhJsonAsync: vi.fn(),
  getGhErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
}));

vi.mock("../commands/task.js", () => ({
  runTaskPlan: vi.fn(),
}));

import { MAX_TASK_LIST_TEXT_CHARS, type Task, type TaskStore } from "@fusion/core";
import { hasBuiltCoreDistBarrel } from "@fusion/test-utils";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Mock ExtensionAPI that captures registrations (mirrors extension.test.ts) ──

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function>();

  const api = {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    on(event: string, handler: Function) {
      events.set(event, handler);
    },
    tools,
    commands,
    events,
  };

  return api as any;
}

function makeCtx(cwd: string) {
  return { cwd } as any;
}

/*
FNXC:CliTests 2026-07-18-07:15:
FN-8271 removes the PG template-database fixture from this built-barrel regression guard. The tool only reads `listTasks`, so coupling its required dist recompilation to CREATE DATABASE ... TEMPLATE and twenty persistent writes made one beforeAll compete for both CPU and the shared PostgreSQL DDL server under shard-4 load. Keep the fixture in memory and inject it through the extension's explicit test cache seam: this preserves the actual fn_task_list formatting/truncation surface while leaving PG isolation coverage to the shared harness consumers that require it.
*/
const distBarrelTasks = Array.from({ length: 20 }, (_, index) => ({
  id: `FN-${String(index + 1).padStart(3, "0")}`,
  title: `Runtime-dist todo task ${String(index + 1).padStart(3, "0")} ${"x".repeat(300)}`,
  description: `Runtime-dist todo task ${String(index + 1).padStart(3, "0")}`,
  column: "todo",
  dependencies: index === 0 ? [] : ["FN-001"],
  paused: false,
  steps: [],
  currentStep: 0,
}) satisfies Partial<Task>) as Task[];

const distBarrelListStore = {
  listTasks: vi.fn(async () => distBarrelTasks),
} as unknown as TaskStore;

describe.skipIf(!hasBuiltCoreDistBarrel(resolve(__dirname, "../../../core/dist")))(
  "fn pi extension (dist-barrel recompilation slice)",
  () => {
    let tmpDir: string;
    let listTool: RegisteredTool;
    let closeRuntimeCachedStores: (() => Promise<void>) | undefined;
    let runtimeDistArtifactUnavailable = false;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "fn-ext-dist-barrel-"));

      /*
      FNXC:CliTests 2026-07-18-07:15:
      The remaining beforeAll work is only built-dist recompilation. The synchronous barrel predicate covers its direct artifacts but cannot prove every transitive runtime import exists, so record ERR_MODULE_NOT_FOUND here and let each test use its own context to skip cleanly instead of calling a nonexistent suite-hook ctx.skip(). The list-only injected fixture has no connection or file handles; close the runtime cache before removing its temporary project root.
      */
      try {
        vi.resetModules();
        const distCoreIndex = resolve(__dirname, "../../../core/dist/index.js");
        const distCoreUrl = pathToFileURL(distCoreIndex).href;
        const distCoreModule = await vi.importActual<typeof import("@fusion/core")>(distCoreUrl);
        vi.doMock("@fusion/core", () => distCoreModule);

        const runtimeModule = await import("../extension.js?fn6535-runtime-core-dist");
        closeRuntimeCachedStores = runtimeModule.closeCachedStores;
        const runtimeApi = createMockAPI();
        runtimeModule.default(runtimeApi);
        runtimeModule.__setCachedStoreForTesting(resolve(tmpDir), distBarrelListStore);
        listTool = runtimeApi.tools.get("fn_task_list")!;
      } catch (error) {
        const code = error instanceof Error && "code" in error
          ? (error as Error & { code?: string }).code
          : undefined;
        if (code === "ERR_MODULE_NOT_FOUND") {
          runtimeDistArtifactUnavailable = true;
          return;
        }
        throw error;
      }
    });

    afterAll(async () => {
      try {
        await closeRuntimeCachedStores?.();
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true });
        }
      } finally {
        vi.doUnmock("@fusion/core");
        vi.resetModules();
      }
    });

    /*
    FNXC:TaskListOutput 2026-06-17-02:37:
    FN-6535 reproduces the heartbeat failure at the actual CLI tool surface while forcing @fusion/core to resolve through the built dist barrel. The normal CLI suite aliases @fusion/core to source, so this targeted mock is the regression guard for stale exports.import dist artifacts.

    FNXC:CoreTests 2026-06-18-01:35:
    FN-6627 aligns the skip gate with every built @fusion/core dist artifact this runtime-dist mock loads, so a partial stale dist skips cleanly while a complete dist still exercises the heartbeat fn_task_list surface.

    FNXC:CliTests 2026-06-19-11:17:
    FN-6734 keeps this guard in the default 5s lane by preserving the runtime-dist truncation invariant with fewer fixture writes instead of appeasing timeouts or reducing workers.

    FNXC:CliTests 2026-06-19-13:16:
    The full CLI affected lane runs this file beside many module-mocking suites; verify the built barrel is importable in the executing worker before installing the mock, then skip like the partial-dist gate if a concurrent lane observes stale dist artifacts.

    FNXC:CliTests 2026-07-04-13:50:
    FN-7530 moved this case out of extension.test.ts unchanged (same assertions, same dist-resolution invariant, same skip gate). The sibling source-@fusion/core test "bounds large column-filtered listings as a single plain-text block" in extension.test.ts covers the identical truncation invariant against source; this test's only marginal coverage is that the built dist barrel resolves/executes identically, which is why it stays a dedicated, narrowly-scoped file rather than being deleted.
    */
    it("lists the built-dist barrel fixture broadly within the text budget", async (ctx) => {
      if (runtimeDistArtifactUnavailable) return ctx.skip();

      const broadResult = await listTool.execute(
        "list-runtime-dist-broad",
        { limit: 20 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const broadText = broadResult.content[0].text;
      expect(broadResult.content).toHaveLength(1);
      expect(broadResult.content[0].type).toBe("text");
      expect(broadText.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
      expect(broadText).toContain("Todo (20):");
      expect(broadText).toContain("FN-001");
      expect(broadText).toContain("[deps: FN-001]");
      expect(broadText).toContain("truncated to fit; narrow with column/limit");
    });

    it("lists the built-dist barrel todo column within the text budget", async (ctx) => {
      if (runtimeDistArtifactUnavailable) return ctx.skip();

      const todoResult = await listTool.execute(
        "list-runtime-dist-todo",
        { column: "todo", limit: 20 },
        undefined,
        undefined,
        makeCtx(tmpDir),
      );
      const todoText = todoResult.content[0].text;
      expect(todoResult.content).toHaveLength(1);
      expect(todoResult.content[0].type).toBe("text");
      expect(todoText.length).toBeLessThanOrEqual(MAX_TASK_LIST_TEXT_CHARS);
      expect(todoText).toContain("Todo (20):");
      expect(todoText).toContain("FN-001");
      expect(todoText).toContain("[deps: FN-001]");
      expect(todoText).toContain("truncated to fit; narrow with column/limit");
      expect(todoResult.details.count).toBe(20);
    });
  },
);
