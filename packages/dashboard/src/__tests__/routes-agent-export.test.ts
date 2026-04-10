import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { request } from "../test-request.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockExportAgentsToDirectory = vi.fn();
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      listAgents = mockListAgents;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    exportAgentsToDirectory: (...args: unknown[]) => mockExportAgentsToDirectory(...args),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1190-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1190-test/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }
}

async function postExport(app: Parameters<typeof request>[0], body: unknown) {
  return request(app, "POST", "/api/agents/export", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

describe("POST /api/agents/export", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let testDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = mkdtempSync(join(tmpdir(), "kb-agent-export-route-"));

    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO",
        role: "executor",
        state: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
      {
        id: "agent-2",
        name: "Reviewer",
        role: "reviewer",
        state: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
    ]);

    mockExportAgentsToDirectory.mockResolvedValue({
      outputDir: join(testDir, "export"),
      agentsExported: 2,
      skillsExported: 1,
      filesWritten: [join(testDir, "export", "COMPANY.md")],
      errors: [],
    });

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("exports all agents when agentIds is omitted", async () => {
    const response = await postExport(app, {});

    expect(response.status).toBe(200);
    expect(mockExportAgentsToDirectory).toHaveBeenCalledTimes(1);
    const [agentsArg, outputDirArg] = mockExportAgentsToDirectory.mock.calls[0] ?? [];
    expect(agentsArg).toHaveLength(2);
    expect(typeof outputDirArg).toBe("string");

    const body = response.body as any;
    expect(body.agentsExported).toBe(2);
    expect(body.skillsExported).toBe(1);
  });

  it("exports only requested agent IDs", async () => {
    const response = await postExport(app, { agentIds: ["agent-2"] });

    expect(response.status).toBe(200);
    const [agentsArg] = mockExportAgentsToDirectory.mock.calls[0] ?? [];
    expect(agentsArg).toHaveLength(1);
    expect(agentsArg[0]?.id).toBe("agent-2");
  });

  it("passes custom company options and output directory", async () => {
    const customOutputDir = join(testDir, "custom-output");

    const response = await postExport(app, {
      companyName: "Acme AI",
      companySlug: "acme-ai",
      outputDir: customOutputDir,
    });

    expect(response.status).toBe(200);
    const [, outputDirArg, optionsArg] = mockExportAgentsToDirectory.mock.calls[0] ?? [];
    expect(outputDirArg).toBe(customOutputDir);
    expect(optionsArg).toEqual({ companyName: "Acme AI", companySlug: "acme-ai" });
  });

  it("returns 400 when no agents are available", async () => {
    mockListAgents.mockResolvedValue([]);

    const response = await postExport(app, {});

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("No agents found to export");
  });

  it("returns 400 for invalid outputDir type", async () => {
    const response = await postExport(app, { outputDir: 123 });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("outputDir must be a string");
  });
});
