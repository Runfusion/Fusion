import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, TaskStore } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";

const sessionCapture = vi.hoisted(() => ({ prompt: "", systemPrompt: "" }));

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
    runtimeLog: createMockLogger(),
  };
});

vi.mock("../pi.js", () => ({
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));

vi.mock("../agent-session-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-session-helpers.js")>("../agent-session-helpers.js");
  return {
    ...actual,
    createResolvedAgentSession: vi.fn(async (options: any) => {
      sessionCapture.systemPrompt = options.systemPrompt ?? "";
      return {
        session: {
          prompt: async (prompt: string) => {
            sessionCapture.prompt = prompt;
          },
          dispose: vi.fn(),
          getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        },
      };
    }),
  };
});

type Harness = {
  rootDir: string;
  globalDir: string;
  taskStore: TaskStore;
  agentStore: AgentStore;
  agentId: string;
};

async function createHarness(mode: "full" | "index" | "off"): Promise<Harness> {
  const rootDir = mkdtempSync(join(tmpdir(), "hb-memory-mode-root-"));
  const globalDir = mkdtempSync(join(tmpdir(), "hb-memory-mode-global-"));
  const taskStore = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await taskStore.init();
  await taskStore.updateSettings({ agentMemoryInclusionMode: mode });
  const agentStore = new AgentStore({ rootDir: taskStore.getFusionDir(), taskStore, inMemoryDb: true });
  const agent = await agentStore.createAgent({
    name: "Memory Mode Agent",
    role: "engineer",
    soul: "Follows memory mode instructions.",
    memory: "INLINE_AGENT_MEMORY_SECRET",
    runtimeConfig: { enabled: true },
  });
  const memoryDir = join(rootDir, ".fusion", "agent-memory", agent.id);
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "MEMORY.md"), "## Notes\n\nworkspace memory details\n", "utf-8");
  return { rootDir, globalDir, taskStore, agentStore, agentId: agent.id };
}

describe("heartbeat memory inclusion mode", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    sessionCapture.prompt = "";
    sessionCapture.systemPrompt = "";
  });

  afterEach(() => {
    if (harness) {
      rmSync(harness.rootDir, { recursive: true, force: true });
      rmSync(harness.globalDir, { recursive: true, force: true });
      harness = null;
    }
  });

  it("full mode includes full memory body", async () => {
    harness = await createHarness("full");
    const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.systemPrompt).toContain("INLINE_AGENT_MEMORY_SECRET");
  });

  it("index mode includes index header and omits full memory body", async () => {
    harness = await createHarness("index");
    const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.systemPrompt).toContain("## Agent Memory Index (use fn_memory_search / fn_memory_get to read)");
    expect(sessionCapture.systemPrompt).not.toContain("INLINE_AGENT_MEMORY_SECRET");
  });

  it("off mode omits agent memory section", async () => {
    harness = await createHarness("off");
    const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    expect(sessionCapture.systemPrompt).not.toContain("## Agent Memory");
    expect(sessionCapture.systemPrompt).not.toContain("INLINE_AGENT_MEMORY_SECRET");
  });

  it("logs mode transition exactly once until mode changes", async () => {
    harness = await createHarness("index");
    const appendSpy = vi.spyOn(harness.agentStore, "appendRunLog");
    const monitor = new HeartbeatMonitor({ store: harness.agentStore, taskStore: harness.taskStore, rootDir: harness.rootDir });

    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });
    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    const transitionLogs = appendSpy.mock.calls.filter(([, , entry]) => entry.text.includes("Agent memory inclusion mode:"));
    expect(transitionLogs).toHaveLength(1);

    await harness.agentStore.updateAgent(harness.agentId, {
      runtimeConfig: { enabled: true, agentMemoryInclusionMode: "off", lastAgentMemoryInclusionMode: "index" },
    });
    await monitor.executeHeartbeat({ agentId: harness.agentId, source: "timer" as any });

    const transitionLogsAfterChange = appendSpy.mock.calls.filter(([, , entry]) => entry.text.includes("Agent memory inclusion mode:"));
    expect(transitionLogsAfterChange).toHaveLength(2);
  });
});
