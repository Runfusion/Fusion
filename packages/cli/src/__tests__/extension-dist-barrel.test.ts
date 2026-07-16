import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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

import { TaskStore, MAX_TASK_LIST_TEXT_CHARS } from "@fusion/core";
import { hasBuiltCoreDistBarrel } from "@fusion/test-utils";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";

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

async function removeDirWithRetries(path: string) {
  /*
  FNXC:CliTests 2026-06-19-11:23:
  FN-6734 showed fixture removal can race SQLite/WAL close on loaded CLI workers; retry cleanup long enough for handles to drain instead of masking test bodies with larger timeouts or worker limits.
  */
  const maxAttempts = 12;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }

      if (attempt === maxAttempts) {
        throw error;
      }

      await delay(50 * attempt);
    }
  }
}

pgDescribe.skipIf(!hasBuiltCoreDistBarrel(resolve(__dirname, "../../../core/dist")))(
  "fn pi extension (dist-barrel recompilation slice)",
  () => {
    let tmpDir: string;
    let fixtureHarness: PgTestHarness | undefined;
    let fixtureStore: TaskStore | undefined;
    let listTool: RegisteredTool;
    let closeRuntimeCachedStores: (() => Promise<void>) | undefined;
    let runtimeDistArtifactUnavailable = false;

    beforeAll(async () => {
      fixtureHarness = await createTaskStoreForTest({ prefix: "fn_ext_dist_barrel" });
      tmpDir = fixtureHarness.rootDir;
      await mkdir(join(tmpDir, ".fusion"), { recursive: true });
      fixtureStore = fixtureHarness.store;
      await fixtureStore.updateSettings({ taskPrefix: "FN" });
      const first = await fixtureStore.createTask({
        title: `Runtime-dist todo task 001 ${"x".repeat(300)}`,
        description: "Runtime-dist todo task 001",
        column: "todo",
      });
      for (let i = 2; i <= 20; i += 1) {
        await fixtureStore.createTask({
          title: `Runtime-dist todo task ${String(i).padStart(3, "0")} ${"x".repeat(300)}`,
          description: `Runtime-dist todo task ${String(i).padStart(3, "0")}`,
          column: "todo",
          dependencies: [first.id],
        });
      }

      /*
      FNXC:CliTests 2026-07-16-06:27:
      FN-8093 rescues the dist-barrel guard by doing its entire CPU-bound recompilation unit and PostgreSQL fixture seeding once in beforeAll, outside each default-5s test body. The dynamic dist extension cannot bootstrap its PostgreSQL backend because its dist migration artifacts are absent, so inject this external fixture store through that module instance's own cache API. Its cache cleanup does not own external stores; afterAll closes the dynamic cache, then this store, before removing the temp root.

      FNXC:CliTests 2026-07-16-06:27:
      The synchronous barrel predicate covers its direct artifacts but cannot prove every transitive runtime import exists. beforeAll receives no Vitest test context, so record ERR_MODULE_NOT_FOUND here and have each test use its own context to skip cleanly instead of calling a nonexistent suite-hook ctx.skip().
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
        runtimeModule.__setCachedStoreForTesting(resolve(tmpDir), fixtureStore);
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
        await fixtureStore?.close();
        if (tmpDir) {
          await removeDirWithRetries(tmpDir);
        }
      } finally {
        await fixtureHarness?.teardown();
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
