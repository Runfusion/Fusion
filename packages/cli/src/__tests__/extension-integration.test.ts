import { it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentStore } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  buildCliWithRealDashboardAssets,
  cliRoot,
} from "./bundle-output-helpers";

/*
FNXC:CliTests 2026-06-14-03:43:
This opt-in built-extension integration suite keeps the one-time 300s beforeAll build override, but every per-test and per-hook path must stay under Vitest's default 5s test and 10s hook caps.
FN-6436 removed the hidden file-wide 30s timeout appeasement after FN-6430 fixed the shared CLI isolation path and FN-6431 established the sibling REMOVE audit pattern.
*/
const extensionBundlePath = join(cliRoot, "dist", "extension.js");

const SHOULD_RUN_EXTENSION_INTEGRATION =
  process.env.FUSION_TEST_EXTENSION_INTEGRATION === "1" ||
  process.env.FUSION_TEST_EXTENSION_INTEGRATION === "true";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
}

type EventHandler = (...args: any[]) => unknown | Promise<unknown>;

interface MockExtensionApi {
  tools: Map<string, RegisteredTool>;
  commands: Map<string, any>;
  events: Map<string, EventHandler>;
  registerTool: (def: RegisteredTool) => void;
  registerCommand: (name: string, def: any) => void;
  registerShortcut: ReturnType<typeof vi.fn>;
  registerFlag: ReturnType<typeof vi.fn>;
  on: (event: string, handler: EventHandler) => void;
}

function createMockAPI(): MockExtensionApi {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const events = new Map<string, EventHandler>();

  return {
    registerTool(def: RegisteredTool) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    on(event: string, handler: EventHandler) {
      events.set(event, handler);
    },
    tools,
    commands,
    events,
  };
}

function makeCtx(cwd: string) {
  return { cwd } as any;
}

interface BuiltExtensionModule {
  default: (api: MockExtensionApi) => void;
  __setCachedStoreForTesting: (projectRoot: string, store: unknown) => void;
  closeCachedStores: () => Promise<void>;
}

async function importBuiltExtension(): Promise<BuiltExtensionModule> {
  const mod = await import(`${pathToFileURL(extensionBundlePath).href}?t=${Date.now()}`) as BuiltExtensionModule;
  if (typeof mod.default !== "function") {
    throw new Error("dist/extension.js did not export the pi extension function");
  }
  return mod;
}

async function seedAgent(
  cwd: string,
  asyncLayer: ReturnType<typeof h.layer>,
  options: { name: string; ephemeral?: boolean },
) {
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion"), asyncLayer });
  await agentStore.init();
  return agentStore.createAgent({
    name: options.name,
    role: "executor",
    metadata: options.ephemeral ? { agentKind: "task-worker" } : {},
  });
}

const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion-built-ext" });

/*
FNXC:PostgresCutover 2026-07-16-08:08:
The CI-shape opt-in contract (`describe.skipIf(!SHOULD_RUN_EXTENSION_INTEGRATION)`) is
preserved semantically by pgDescribe, which additionally skips safely without PostgreSQL.
*/
pgDescribe.skipIf(!SHOULD_RUN_EXTENSION_INTEGRATION)("built fn pi extension integration", () => {
  let tmpDir: string;
  let api: MockExtensionApi;
  let extension: (api: MockExtensionApi) => void;
  let builtExtension: BuiltExtensionModule;

  beforeAll(async () => {
    await buildCliWithRealDashboardAssets();
    await h.beforeAll();
    builtExtension = await importBuiltExtension();
    extension = builtExtension.default;
  }, 300_000);

  beforeEach(async () => {
    await h.beforeEach();
    tmpDir = h.rootDir();
    /*
    FNXC:PostgresCutover 2026-07-16-07:56:
    FN-8081 runs the opt-in built-extension checks against the same injected
    PostgreSQL TaskStore used for agent seeding and persistence assertions.
    */
    builtExtension.__setCachedStoreForTesting(tmpDir, h.store());
    api = createMockAPI();
    extension(api);
  });

  afterEach(async () => {
    const shutdown = api.events.get("session_shutdown");
    if (shutdown) await shutdown();
    /*
     * FNXC:PostgresCutover 2026-07-16-09:05:
     * The bundle owns a separate module cache. Clear its externally-owned PG
     * entry before the shared harness closes that store, even if the shutdown
     * hook already cleared it, so no built-module cache leaks across tests.
     */
    await builtExtension.closeCachedStores();
    await h.afterEach();
  });

  afterAll(async () => {
    await h.afterAll();
  });

  it("registers the current public extension surface from dist/extension.js", () => {
    expect(api.commands.has("fn")).toBe(true);
    expect(api.events.has("session_shutdown")).toBe(true);

    for (const toolName of [
      "fn_task_create",
      "fn_task_list",
      "fn_task_show",
      "fn_task_logs_read",
      "fn_agent_create",
      "fn_agent_delete",
      "fn_list_agents",
      "fn_delegate_task",
      "fn_agent_show",
      "fn_skills_install",
    ]) {
      expect(api.tools.has(toolName), `${toolName} should be registered`).toBe(true);
    }

    for (const internalToolName of [
      "fn_task_move",
      "fn_task_update_step",
      "fn_task_log",
      "fn_task_merge",
    ]) {
      expect(api.tools.has(internalToolName), `${internalToolName} should stay engine-internal`).toBe(false);
    }
  });

  it("exposes a callable session_shutdown handler", async () => {
    const shutdown = api.events.get("session_shutdown");
    expect(typeof shutdown).toBe("function");
    await expect(shutdown?.()).resolves.toBeUndefined();
  });

  it("creates and lists tasks through the built extension", async () => {
    const createTool = api.tools.get("fn_task_create")!;
    const created = await createTool.execute(
      "create-1",
      { description: "Ship the packed CLI contract" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(created.details.taskId).toMatch(/^[A-Z]+-\d+$/);
    expect(created.details.column).toBe("triage");
    expect(created.details.priority).toBe("normal");

    const listTool = api.tools.get("fn_task_list")!;
    const listed = await listTool.execute("list-1", {}, undefined, undefined, makeCtx(tmpDir));
    expect(listed.content[0].text).toContain(created.details.taskId);
    expect(listed.content[0].text).toContain("Ship the packed CLI contract");

    const persisted = await h.store().getTask(created.details.taskId);
    expect(persisted?.description).toBe("Ship the packed CLI contract");

    const urgent = await createTool.execute(
      "create-2",
      { description: "Needs urgency", priority: "high" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(urgent.details.priority).toBe("high");
    const urgentPersisted = await h.store().getTask(urgent.details.taskId);
    expect(urgentPersisted?.priority).toBe("high");
  });

  it("runs provisioning tools through the built extension", async () => {
    const createTool = api.tools.get("fn_agent_create")!;
    const created = await createTool.execute(
      "create-agent-1",
      { name: "built-ext-agent", role: "executor" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(created.details.outcome).toBe("created");
    expect(created.details.agentId).toMatch(/^agent-/);

    const deleteTool = api.tools.get("fn_agent_delete")!;
    const deleted = await deleteTool.execute(
      "delete-agent-1",
      { agent_id: created.details.agentId },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(deleted.details.outcome).toBe("deleted");
    expect(deleted.details.agentId).toBe(created.details.agentId);
  });

  it("delegates to real non-ephemeral agents and rejects runtime workers", async () => {
    const agent = await seedAgent(tmpDir, h.layer(), { name: "release-agent" });
    const runtimeWorker = await seedAgent(
      tmpDir,
      h.layer(),
      { name: "runtime-worker", ephemeral: true },
    );

    const listAgentsTool = api.tools.get("fn_list_agents")!;
    const listedAgents = await listAgentsTool.execute("agents-1", {}, undefined, undefined, makeCtx(tmpDir));
    expect(listedAgents.content[0].text).toContain("release-agent");
    expect(listedAgents.content[0].text).not.toContain("runtime-worker");

    const delegateTool = api.tools.get("fn_delegate_task")!;
    const delegated = await delegateTool.execute(
      "delegate-1",
      { agent_id: agent.id, description: "Verify release locally" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(delegated.details.agentId).toBe(agent.id);
    expect(delegated.content[0].text).toContain("release-agent");

    const rejected = await delegateTool.execute(
      "delegate-2",
      { agent_id: runtimeWorker.id, description: "Should not assign" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("ephemeral/runtime agent");
  });

  /*
   * FNXC:PostgresCutover 2026-07-16-16:00:
   * SQLite triggers were removed with the backend cutover. Inject the collision
   * at the shared PostgreSQL TaskStore boundary so this built-extension test
   * continues to prove the user-facing delegate error rather than skipping it.
   */
  it("returns explicit error when fn_delegate_task hits task-id collision", async () => {
    const agent = await seedAgent(tmpDir, h.layer(), { name: "release-agent" });
    const createTask = vi
      .spyOn(h.store(), "createTask")
      .mockRejectedValueOnce(new Error("Task ID already exists: FN-001"));

    const delegateTool = api.tools.get("fn_delegate_task")!;
    const result = await delegateTool.execute(
      "delegate-collision",
      { agent_id: agent.id, description: "collision task" },
      undefined,
      undefined,
      makeCtx(tmpDir),
    );

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Task ID already exists: FN-001");
    expect(result.details.error).toContain("Task ID already exists: FN-001");
  });
});
