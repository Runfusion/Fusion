import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

// ── Mock @fusion/core for agent import ────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockCreateAgent = vi.fn();

const mockParseCompaniesShManifest = vi.fn();
const mockConvertCompaniesShAgents = vi.fn();

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      listAgents = mockListAgents;
      createAgent = mockCreateAgent;
    },
    parseCompaniesShManifest: (...args: unknown[]) => mockParseCompaniesShManifest(...args),
    convertCompaniesShAgents: (...args: unknown[]) => mockConvertCompaniesShAgents(...args),
    CompaniesShParseError: class CompaniesShParseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CompaniesShParseError";
      }
    },
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-976-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-976-test/.fusion";
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

// ── Helpers ───────────────────────────────────────────────────────────

function encodeManifest(agents: unknown[]): string {
  return Buffer.from(JSON.stringify(agents)).toString("base64");
}

function makeScript(companyName: string, agents: unknown[]): string {
  const manifest = encodeManifest(agents);
  return `#!/bin/bash\nCOMPANY_NAME="${companyName}"\nAGENT_MANIFEST="${manifest}"`;
}

async function postImport(app: Parameters<typeof request>[0], body: unknown) {
  return request(app, "POST", "/api/agents/import", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("POST /api/agents/import", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    // Reset mock implementations (don't reassign variables — class fields capture by reference)
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);
    mockCreateAgent.mockReset();

    mockParseCompaniesShManifest.mockReturnValue({
      companyName: "test-co",
      agents: [{ name: "Test Agent", role: "executor" }],
      envVars: [],
    });
    mockConvertCompaniesShAgents.mockReturnValue({
      inputs: [{ name: "Test Agent", role: "executor" }],
      result: {
        created: ["Test Agent"],
        skipped: [],
        errors: [],
      },
    });

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when manifest is missing", async () => {
    const response = await postImport(app, {});

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("manifest is required");
  });

  it("returns 400 when manifest is not a string or valid object", async () => {
    const response = await postImport(app, { manifest: 12345 });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("manifest must be");
  });

  it("returns 400 on invalid manifest content", async () => {
    const { CompaniesShParseError } = await import("@fusion/core");
    mockParseCompaniesShManifest.mockImplementation(() => {
      throw new CompaniesShParseError("Missing COMPANY_NAME variable in manifest");
    });

    const response = await postImport(app, { manifest: "not a valid manifest" });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Missing COMPANY_NAME");
  });

  it("returns 400 when manifest has no agents", async () => {
    mockParseCompaniesShManifest.mockReturnValue({
      companyName: "empty-co",
      agents: [],
      envVars: [],
    });

    const response = await postImport(app, { manifest: makeScript("empty-co", []) });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("No agents found");
  });

  it("imports agents successfully", async () => {
    mockCreateAgent.mockResolvedValue({ id: "agent-1", name: "Test Agent" });

    const response = await postImport(app, { manifest: makeScript("test-co", [{ name: "Test Agent", role: "executor" }]) });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.companyName).toBe("test-co");
    expect(body.created).toHaveLength(1);
    expect(body.created[0].name).toBe("Test Agent");
    expect(body.errors).toHaveLength(0);
  });

  it("returns dry-run preview without creating agents", async () => {
    mockConvertCompaniesShAgents.mockReturnValue({
      inputs: [{ name: "Preview Agent", role: "executor" }],
      result: {
        created: ["Preview Agent"],
        skipped: [],
        errors: [],
      },
    });

    const response = await postImport(app, {
      manifest: makeScript("preview-co", [{ name: "Preview Agent", role: "executor" }]),
      dryRun: true,
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.dryRun).toBe(true);
    expect(body.companyName).toBe("test-co");
    expect(body.created).toContain("Preview Agent");
    // Should NOT call createAgent in dry-run mode
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("skips existing agents when skipExisting is true", async () => {
    mockListAgents.mockResolvedValue([{ id: "existing-1", name: "Existing Agent" }]);
    mockConvertCompaniesShAgents.mockReturnValue({
      inputs: [{ name: "New Agent", role: "reviewer" }],
      result: {
        created: ["New Agent"],
        skipped: ["Existing Agent"],
        errors: [],
      },
    });
    mockCreateAgent.mockResolvedValue({ id: "agent-2", name: "New Agent" });

    const response = await postImport(app, {
      manifest: makeScript("skip-co", [
        { name: "Existing Agent", role: "executor" },
        { name: "New Agent", role: "reviewer" },
      ]),
      skipExisting: true,
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skipped).toContain("Existing Agent");
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("reports per-agent creation errors", async () => {
    mockConvertCompaniesShAgents.mockReturnValue({
      inputs: [
        { name: "Good Agent", role: "executor" },
        { name: "Bad Agent", role: "reviewer" },
      ],
      result: {
        created: ["Good Agent", "Bad Agent"],
        skipped: [],
        errors: [],
      },
    });
    mockCreateAgent
      .mockResolvedValueOnce({ id: "agent-1", name: "Good Agent" })
      .mockRejectedValueOnce(new Error("Database error"));

    const response = await postImport(app, {
      manifest: makeScript("mixed-co", [
        { name: "Good Agent", role: "executor" },
        { name: "Bad Agent", role: "reviewer" },
      ]),
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.created).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].name).toBe("Bad Agent");
    expect(body.errors[0].error).toContain("Database error");
  });

  it("accepts pre-parsed manifest object with agents array", async () => {
    const response = await postImport(app, {
      manifest: {
        companyName: "parsed-co",
        agents: [{ name: "Parsed Agent", role: "executor" }],
        envVars: [],
      },
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.companyName).toBe("parsed-co");
  });
});
