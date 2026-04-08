import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "../test-request.js";

// ── Mock @fusion/core for agent import ────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockCreateAgent = vi.fn();

const mockParseCompaniesShManifest = vi.fn();
const mockConvertCompaniesShAgents = vi.fn();
const mockParseCompanyDirectory = vi.fn();
const mockParseCompanyArchive = vi.fn();
const mockParseAgentManifest = vi.fn();
const mockConvertAgentCompanies = vi.fn();

class MockCompaniesShParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompaniesShParseError";
  }
}

class MockAgentCompaniesParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCompaniesParseError";
  }
}

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      listAgents = mockListAgents;
      createAgent = mockCreateAgent;
    },
    parseCompaniesShManifest: (...args: unknown[]) => mockParseCompaniesShManifest(...args),
    convertCompaniesShAgents: (...args: unknown[]) => mockConvertCompaniesShAgents(...args),
    parseCompanyDirectory: (...args: unknown[]) => mockParseCompanyDirectory(...args),
    parseCompanyArchive: (...args: unknown[]) => mockParseCompanyArchive(...args),
    parseAgentManifest: (...args: unknown[]) => mockParseAgentManifest(...args),
    convertAgentCompanies: (...args: unknown[]) => mockConvertAgentCompanies(...args),
    CompaniesShParseError: MockCompaniesShParseError,
    AgentCompaniesParseError: MockAgentCompaniesParseError,
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1189-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1189-test/.fusion";
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
  let testDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = mkdtempSync(join(tmpdir(), "kb-agent-import-route-"));

    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);
    mockCreateAgent.mockReset();
    mockCreateAgent.mockImplementation(async (input: any) => ({ id: `agent-${input.name}`, ...input }));

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

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co" },
      agents: [{ name: "Dir Agent", skills: ["executor"] }],
      teams: [],
      projects: [],
      tasks: [],
      skills: [],
    });
    mockParseCompanyArchive.mockResolvedValue({
      company: { name: "Archive Co" },
      agents: [{ name: "Archive Agent", skills: ["executor"] }],
      teams: [],
      projects: [],
      tasks: [],
      skills: [],
    });
    mockParseAgentManifest.mockReturnValue({
      name: "YAML Agent",
      title: "Chief Executive",
      skills: ["review"],
      instructionBody: "Instructions",
    });
    mockConvertAgentCompanies.mockReturnValue({
      inputs: [{ name: "YAML Agent", role: "reviewer", title: "Chief Executive", metadata: { skills: ["review"] } }],
      result: {
        created: ["YAML Agent"],
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
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns 400 when no supported input mode is provided", async () => {
    const response = await postImport(app, {});

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Provide one of");
  });

  it("imports agents via Mode 1 (agents array)", async () => {
    const response = await postImport(app, {
      agents: [{ name: "Test Agent", skills: ["executor"] }],
    });

    expect(response.status).toBe(200);
    expect(mockConvertAgentCompanies).toHaveBeenCalledTimes(1);
    const body = response.body as any;
    expect(body.created).toHaveLength(1);
    expect(body.created[0].name).toBe("YAML Agent");
  });

  it("imports agents via Mode 2 (source directory)", async () => {
    const sourceDir = join(testDir, "company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    expect(mockParseCompanyDirectory).toHaveBeenCalledWith(sourceDir);
    const body = response.body as any;
    expect(body.created).toHaveLength(1);
  });

  it("imports agents via Mode 3 manifest string (YAML frontmatter)", async () => {
    const response = await postImport(app, {
      manifest: "---\nname: YAML Agent\nskills:\n  - review\n---\nInstructions",
    });

    expect(response.status).toBe(200);
    expect(mockParseAgentManifest).toHaveBeenCalled();
    expect(mockParseCompaniesShManifest).not.toHaveBeenCalled();
  });

  it("falls back to legacy .sh parsing when YAML parse fails", async () => {
    mockParseAgentManifest.mockImplementation(() => {
      throw new MockAgentCompaniesParseError("Missing YAML frontmatter delimiters (---)");
    });

    const response = await postImport(app, {
      manifest: makeScript("fallback-co", [{ name: "Legacy Agent", role: "executor" }]),
    });

    expect(response.status).toBe(200);
    expect(mockParseCompaniesShManifest).toHaveBeenCalledTimes(1);
    const body = response.body as any;
    expect(body.created).toHaveLength(1);
  });

  it("returns dry-run previews with agents array and does not create agents", async () => {
    const response = await postImport(app, {
      manifest: "---\nname: YAML Agent\nskills:\n  - review\n---\nInstructions",
      dryRun: true,
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.dryRun).toBe(true);
    expect(body.agents).toEqual([
      expect.objectContaining({ name: "YAML Agent", role: "reviewer", title: "Chief Executive" }),
    ]);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported source paths", async () => {
    const unsupportedPath = join(testDir, "manifest.json");
    writeFileSync(unsupportedPath, "{}");

    const response = await postImport(app, {
      source: unsupportedPath,
    });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Unsupported source format");
  });

  it("honors skipExisting and returns skipped agents", async () => {
    mockListAgents.mockResolvedValue([{ id: "agent-existing", name: "YAML Agent" }]);
    mockConvertAgentCompanies.mockReturnValue({
      inputs: [],
      result: {
        created: [],
        skipped: ["YAML Agent"],
        errors: [],
      },
    });

    const response = await postImport(app, {
      manifest: "---\nname: YAML Agent\n---\nInstructions",
      skipExisting: true,
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skipped).toEqual(["YAML Agent"]);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });
});
