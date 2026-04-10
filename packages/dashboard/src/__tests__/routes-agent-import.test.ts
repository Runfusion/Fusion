import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "../test-request.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockCreateAgent = vi.fn();
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

const mockParseCompanyDirectory = vi.fn();
const mockParseCompanyArchive = vi.fn();
const mockParseSingleAgentManifest = vi.fn();
const mockConvertAgentCompanies = vi.fn();

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
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    parseCompanyDirectory: (...args: unknown[]) => mockParseCompanyDirectory(...args),
    parseCompanyArchive: (...args: unknown[]) => mockParseCompanyArchive(...args),
    parseSingleAgentManifest: (...args: unknown[]) => mockParseSingleAgentManifest(...args),
    convertAgentCompanies: (...args: unknown[]) => mockConvertAgentCompanies(...args),
    AgentCompaniesParseError: MockAgentCompaniesParseError,
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1174-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1174-test/.fusion";
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

async function postImport(app: Parameters<typeof request>[0], body: unknown) {
  return request(app, "POST", "/api/agents/import", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

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

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
    });

    mockParseCompanyArchive.mockResolvedValue({
      company: { name: "Archive Co", slug: "archive-co" },
      agents: [{ name: "Archive Agent", skills: ["review"] }],
      teams: [{ name: "Ops" }],
      projects: [],
      tasks: [],
    });

    mockParseSingleAgentManifest.mockReturnValue({
      manifest: {
        name: "YAML Agent",
        title: "Chief Executive",
        skills: ["review"],
        instructionBody: "Instructions",
      },
    });

    mockConvertAgentCompanies.mockReturnValue({
      inputs: [{ name: "YAML Agent", role: "custom", title: "Chief Executive", metadata: { skills: ["review"] } }],
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

  it("imports agents via { agents } mode", async () => {
    const response = await postImport(app, {
      agents: [{ name: "Test Agent", skills: ["executor"] }],
    });

    expect(response.status).toBe(200);
    expect(mockConvertAgentCompanies).toHaveBeenCalledTimes(1);
    const body = response.body as any;
    expect(body.created).toHaveLength(1);
    expect(body.created[0].name).toBe("YAML Agent");
    expect(body.companyName).toBe("Unknown");
    expect(body.companySlug).toBeUndefined();
  });

  it("imports agents via { source } directory mode", async () => {
    const sourceDir = join(testDir, "company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    expect(mockParseCompanyDirectory).toHaveBeenCalledWith(sourceDir);
    const body = response.body as any;
    expect(body.companyName).toBe("Directory Co");
    expect(body.companySlug).toBe("directory-co");
    expect(body.created).toHaveLength(1);
  });

  it("imports agents via { source } archive mode", async () => {
    const archivePath = join(testDir, "company.tgz");
    writeFileSync(archivePath, "archive");

    const response = await postImport(app, { source: archivePath });

    expect(response.status).toBe(200);
    expect(mockParseCompanyArchive).toHaveBeenCalledWith(archivePath);
    const body = response.body as any;
    expect(body.companyName).toBe("Archive Co");
    expect(body.companySlug).toBe("archive-co");
  });

  it("rejects non-directory source paths", async () => {
    const filePath = join(testDir, "manifest.md");
    writeFileSync(filePath, "---\nname: Agent\n---");

    const response = await postImport(app, { source: filePath });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("directory");
  });

  it("imports agents via { manifest } AGENTS.md mode", async () => {
    const response = await postImport(app, {
      manifest: "---\nname: YAML Agent\nskills:\n  - review\n---\nInstructions",
    });

    expect(response.status).toBe(200);
    expect(mockParseSingleAgentManifest).toHaveBeenCalled();
  });

  it("returns dry-run preview and does not create agents", async () => {
    const response = await postImport(app, {
      manifest: "---\nname: YAML Agent\n---\nInstructions",
      dryRun: true,
    });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.dryRun).toBe(true);
    expect(body.created).toEqual(["YAML Agent"]);
    expect(body.agents).toEqual([
      expect.objectContaining({ name: "YAML Agent", role: "custom", title: "Chief Executive" }),
    ]);
    expect(mockCreateAgent).not.toHaveBeenCalled();
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

  it("returns 400 for parser errors", async () => {
    mockParseSingleAgentManifest.mockImplementation(() => {
      throw new MockAgentCompaniesParseError("Missing YAML frontmatter delimiters (---)");
    });

    const response = await postImport(app, {
      manifest: "invalid",
    });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Missing YAML frontmatter");
  });
});
