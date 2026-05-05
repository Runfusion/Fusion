import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentStore, TaskStore } from "@fusion/core";
import {
  buildCliWithRealDashboardAssets,
  extensionBundlePath,
} from "./bundle-output-helpers";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

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

async function importBuiltExtension() {
  const mod = await import(`${pathToFileURL(extensionBundlePath).href}?t=${Date.now()}`);
  const extension = mod.default;
  if (typeof extension !== "function") {
    throw new Error("dist/extension.js did not export the pi extension function");
  }
  return extension as (api: MockExtensionApi) => void;
}

async function removeDirWithRetries(path: string) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }
      if (attempt === 4) {
        throw error;
      }
      await delay(25 * attempt);
    }
  }
}

async function seedAgent(cwd: string, options: { name: string; ephemeral?: boolean }) {
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion") });
  await agentStore.init();
  return agentStore.createAgent({
    name: options.name,
    role: "executor",
    metadata: options.ephemeral ? { agentKind: "task-worker" } : {},
  });
}

describe.skipIf(!SHOULD_RUN_EXTENSION_INTEGRATION)("built fn pi extension integration", () => {
  let tmpDir: string;
  let api: MockExtensionApi;
  let extension: (api: MockExtensionApi) => void;

  beforeAll(async () => {
    buildCliWithRealDashboardAssets();
    extension = await importBuiltExtension();
  }, 300_000);

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fusion-built-ext-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    api = createMockAPI();
    extension(api);
  });

  afterEach(async () => {
    const shutdown = api.events.get("session_shutdown");
    if (shutdown) {
      await shutdown();
    }
    await removeDirWithRetries(tmpDir);
  });

  it("registers the current public extension surface from dist/extension.js", () => {
    expect(api.commands.has("fn")).toBe(true);
    expect(api.events.has("session_shutdown")).toBe(true);

    for (const toolName of [
      "fn_task_create",
      "fn_task_list",
      "fn_task_show",
      "fn_list_agents",
      "fn_delegate_task",
      "fn_agent_show",
      "fn_research_run",
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

    const listTool = api.tools.get("fn_task_list")!;
    const listed = await listTool.execute("list-1", {}, undefined, undefined, makeCtx(tmpDir));
    expect(listed.content[0].text).toContain(created.details.taskId);
    expect(listed.content[0].text).toContain("Ship the packed CLI contract");

    const store = new TaskStore(tmpDir);
    await store.init();
    const persisted = await store.getTask(created.details.taskId);
    expect(persisted?.description).toBe("Ship the packed CLI contract");
  });

  it("delegates to real non-ephemeral agents and rejects runtime workers", async () => {
    const agent = await seedAgent(tmpDir, { name: "release-agent" });
    const runtimeWorker = await seedAgent(tmpDir, { name: "runtime-worker", ephemeral: true });

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
});
