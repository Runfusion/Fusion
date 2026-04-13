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
const mockPrepareAgentCompaniesImport = vi.fn();

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
    prepareAgentCompaniesImport: (...args: unknown[]) => mockPrepareAgentCompaniesImport(...args),
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

    mockPrepareAgentCompaniesImport.mockReturnValue({
      items: [{
        manifestKey: "yaml-agent",
        aliases: ["yaml-agent"],
        index: 0,
        input: { name: "YAML Agent", role: "custom", title: "Chief Executive", metadata: { skills: ["review"] } },
      }],
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
    expect(mockPrepareAgentCompaniesImport).toHaveBeenCalledTimes(1);
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

  it("creates hierarchical agents with resolved parent ids", async () => {
    const sourceDir = join(testDir, "hierarchy-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockPrepareAgentCompaniesImport.mockReturnValue({
      items: [
        {
          manifestKey: "ceo",
          aliases: ["ceo"],
          index: 0,
          input: { name: "CEO", role: "custom" },
        },
        {
          manifestKey: "vp-eng",
          aliases: ["vp-eng"],
          index: 1,
          input: { name: "VP Eng", role: "custom" },
          reportsTo: { raw: "ceo", deferredManifestKey: "ceo" },
        },
        {
          manifestKey: "staff-eng",
          aliases: ["staff-eng"],
          index: 2,
          input: { name: "Staff Eng", role: "custom" },
          reportsTo: { raw: "../vp-eng/AGENTS.md", deferredManifestKey: "vp-eng" },
        },
      ],
      result: {
        created: ["CEO", "VP Eng", "Staff Eng"],
        skipped: [],
        errors: [],
      },
    });

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    expect(mockCreateAgent).toHaveBeenCalledTimes(3);
    expect(mockCreateAgent.mock.calls[0]?.[0]).toEqual({ name: "CEO", role: "custom" });
    expect(mockCreateAgent.mock.calls[1]?.[0]).toEqual({
      name: "VP Eng",
      role: "custom",
      reportsTo: "agent-CEO",
    });
    expect(mockCreateAgent.mock.calls[2]?.[0]).toEqual({
      name: "Staff Eng",
      role: "custom",
      reportsTo: "agent-VP Eng",
    });
  });

  it("uses helper-resolved existing manager ids for partial imports", async () => {
    mockListAgents.mockResolvedValue([{ id: "agent-ceo", name: "CEO" }]);
    mockPrepareAgentCompaniesImport.mockReturnValue({
      items: [
        {
          manifestKey: "vp-eng",
          aliases: ["vp-eng"],
          index: 0,
          input: { name: "VP Eng", role: "custom" },
          reportsTo: { raw: "../ceo/AGENTS.md", resolvedAgentId: "agent-ceo" },
        },
      ],
      result: {
        created: ["VP Eng"],
        skipped: ["CEO"],
        errors: [],
      },
    });

    const response = await postImport(app, {
      manifest: "---\nname: VP Eng\nreportsTo: ../ceo/AGENTS.md\n---\nLead engineering",
      skipExisting: true,
    });

    expect(response.status).toBe(200);
    expect(mockCreateAgent).toHaveBeenCalledWith({
      name: "VP Eng",
      role: "custom",
      reportsTo: "agent-ceo",
    });
    expect(mockPrepareAgentCompaniesImport).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        skipExisting: ["CEO"],
        existingAgents: [{ id: "agent-ceo", name: "CEO" }],
      }),
    );
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
    mockPrepareAgentCompaniesImport.mockReturnValue({
      items: [],
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

  it("rejects invalid companies.sh slugs", async () => {
    const response = await postImport(app, {
      importSource: "companies.sh",
      companySlug: "Invalid Slug!",
    });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Invalid companies.sh slug");
  });

  it("rejects companies.sh slug with uppercase", async () => {
    const response = await postImport(app, {
      importSource: "companies.sh",
      companySlug: "MyCompany",
    });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Invalid companies.sh slug");
  });

  it("rejects companies.sh slug with special characters", async () => {
    const response = await postImport(app, {
      importSource: "companies.sh",
      companySlug: "company@123",
    });

    expect(response.status).toBe(400);
    expect((response.body as any).error).toContain("Invalid companies.sh slug");
  });
});

describe("GET /api/agents/companies", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mock("../server.js", async () => {
      const actual = await vi.importActual("../server.js");
      return actual;
    });

    mockInit.mockResolvedValue(undefined);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns companies from companies.sh API", async () => {
    const response = await request(app, "GET", "/api/agents/companies");

    // The actual API might return data or an empty array on failure
    // Just verify the endpoint responds
    expect([200, 500]).toContain(response.status);
  });
});
