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

// Use vi.hoisted to ensure mocks are available when vi.mock runs
const { mockFsAccess, mockFsMkdir, mockFsWriteFile, mockExecFile } = vi.hoisted(() => ({
  mockFsAccess: vi.fn(),
  mockFsMkdir: vi.fn(),
  mockFsWriteFile: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    default: actual,
    mkdtemp: actual.mkdtemp,
    access: mockFsAccess,
    stat: actual.stat,
    mkdir: mockFsMkdir,
    readdir: actual.readdir,
    rm: actual.rm,
    readFile: actual.readFile,
    writeFile: mockFsWriteFile,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

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

function createGitHubArchiveBuffer(_companySlug: string): Buffer {
  return Buffer.from("mock-company-archive");
}

const originalFetch = globalThis.fetch;

describe("POST /api/agents/import", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let testDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    rmSync("/tmp/fn-1174-test", { recursive: true, force: true });
    testDir = mkdtempSync(join(tmpdir(), "fn-agent-import-route-"));

    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);
    mockCreateAgent.mockReset();
    mockCreateAgent.mockImplementation(async (input: any) => ({ id: `agent-${input.name}`, ...input }));

    mockExecFile.mockReset();
    mockExecFile.mockImplementation((command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if ((command === "tar" || command === "bsdtar") && Array.isArray(args)) {
        const extractDirIndex = args.indexOf("-C");
        const extractDir = extractDirIndex >= 0 ? args[extractDirIndex + 1] : undefined;
        if (extractDir) {
          mkdirSync(join(extractDir, "mock-company-main", "acme-ai"), { recursive: true });
        }
      }
      callback(null, "", "");
      return {} as any;
    });

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
      skills: [{ name: "review" }, { name: "strategy" }],
    });

    mockParseCompanyArchive.mockResolvedValue({
      company: { name: "Archive Co", slug: "archive-co" },
      agents: [{ name: "Archive Agent", skills: ["review"] }],
      teams: [{ name: "Ops" }],
      projects: [],
      tasks: [],
      skills: [{ name: "review" }, { name: "strategy" }],
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
    globalThis.fetch = originalFetch;
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
    expect(body.skillsCount).toBe(0);
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
    expect(body.skillsCount).toBe(2);
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
    expect(body.skillsCount).toBe(2);
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
    expect(body.skills).toEqual([]);
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

  it("dry-run preview includes skills from company package", async () => {
    const sourceDir = join(testDir, "skills-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
      skills: [
        { name: "review", description: "Review implementation details" },
        { name: "strategy" },
      ],
    });

    const response = await postImport(app, { source: sourceDir, dryRun: true });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills).toEqual([
      { name: "review", description: "Review implementation details" },
      { name: "strategy" },
    ]);
  });

  it("dry-run preview returns empty skills when package has no skills", async () => {
    const sourceDir = join(testDir, "no-skills-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
    });

    const response = await postImport(app, { source: sourceDir, dryRun: true });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills).toEqual([]);
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

  it("returns companies.sh dry-run preview with package skills", async () => {
    const archiveBuffer = createGitHubArchiveBuffer("acme-ai");

    globalThis.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "https://companies.sh/api/companies") {
        return Promise.resolve(new Response(
          JSON.stringify({ items: [{ slug: "acme-ai", name: "Acme AI", repo: "acme/reviewers" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ));
      }

      if (url === "https://github.com/acme/reviewers/archive/refs/heads/main.tar.gz") {
        return Promise.resolve(new Response(archiveBuffer, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        }));
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    mockParseCompanyArchive.mockResolvedValue({
      company: { name: "Acme AI", slug: "acme-ai" },
      agents: [{ name: "Reviewer", skills: ["review"] }],
      teams: [],
      projects: [],
      tasks: [],
      skills: [{ name: "review", description: "Review implementation details" }],
    });

    const response = await postImport(app, {
      importSource: "companies.sh",
      companySlug: "acme-ai",
      dryRun: true,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as any;
    expect(body.dryRun).toBe(true);
    expect(body.companyName).toBe("Acme AI");
    expect(body.companySlug).toBe("acme-ai");
    expect(body.agents).toEqual([expect.objectContaining({ name: "YAML Agent" })]);
    expect(body.skills).toEqual([{ name: "review", description: "Review implementation details" }]);
  });

  it("returns companies.sh live import with skill import result", async () => {
    const archiveBuffer = createGitHubArchiveBuffer("acme-ai");

    globalThis.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "https://companies.sh/api/companies") {
        return Promise.resolve(new Response(
          JSON.stringify({ items: [{ slug: "acme-ai", name: "Acme AI", repo: "acme/reviewers" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ));
      }

      if (url === "https://github.com/acme/reviewers/archive/refs/heads/main.tar.gz") {
        return Promise.resolve(new Response(archiveBuffer, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        }));
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    mockParseCompanyArchive.mockResolvedValue({
      company: { name: "Acme AI", slug: "acme-ai" },
      agents: [{ name: "Reviewer", skills: ["review"] }],
      teams: [],
      projects: [],
      tasks: [],
      skills: [{ name: "review", description: "Review implementation details" }],
    });

    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();
    mockFsAccess.mockRejectedValue(new Error("ENOENT"));
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);

    const response = await postImport(app, {
      importSource: "companies.sh",
      companySlug: "acme-ai",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as any;
    expect(body.companyName).toBe("Acme AI");
    expect(body.companySlug).toBe("acme-ai");
    expect(body.skillsCount).toBe(1);
    expect(body.skills).toEqual({
      imported: [
        expect.objectContaining({
          name: "review",
          path: expect.stringContaining("skills/imported/acme-ai/review/SKILL.md"),
        }),
      ],
      skipped: [],
      errors: [],
    });
    expect(mockFsWriteFile).toHaveBeenCalledTimes(1);
  });

  it("imports only selected companies.sh agents and skills", async () => {
    const archiveBuffer = createGitHubArchiveBuffer("acme-ai");

    globalThis.fetch = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === "https://companies.sh/api/companies") {
        return Promise.resolve(new Response(
          JSON.stringify({ items: [{ slug: "acme-ai", name: "Acme AI", repo: "acme/reviewers" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ));
      }

      if (url === "https://github.com/acme/reviewers/archive/refs/heads/main.tar.gz") {
        return Promise.resolve(new Response(archiveBuffer, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        }));
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    mockParseCompanyArchive.mockResolvedValue({
      company: { name: "Acme AI", slug: "acme-ai" },
      agents: [
        { name: "Reviewer", skills: ["review"] },
        { name: "Planner", skills: ["strategy"] },
      ],
      teams: [],
      projects: [],
      tasks: [],
      skills: [
        { name: "review", description: "Review implementation details" },
        { name: "strategy", description: "Plan implementation details" },
      ],
    });

    mockPrepareAgentCompaniesImport.mockImplementation((pkg: any) => ({
      items: (pkg.agents ?? []).map((agent: { name: string }, index: number) => ({
        manifestKey: agent.name.toLowerCase(),
        aliases: [agent.name.toLowerCase()],
        index,
        input: { name: agent.name, role: "custom" },
      })),
      result: {
        created: (pkg.agents ?? []).map((agent: { name: string }) => agent.name),
        skipped: [],
        errors: [],
      },
    }));

    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();
    mockFsAccess.mockRejectedValue(new Error("ENOENT"));
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);

    const response = await postImport(app, {
      importSource: "companies.sh",
      companySlug: "acme-ai",
      selectedAgents: ["Reviewer"],
      selectedSkills: ["review"],
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as any;
    expect(body.created).toEqual([{ id: "agent-Reviewer", name: "Reviewer" }]);
    expect(body.skillsCount).toBe(1);
    expect(body.skills.imported).toEqual([
      expect.objectContaining({
        name: "review",
        path: expect.stringContaining("skills/imported/acme-ai/review/SKILL.md"),
      }),
    ]);
    expect(mockFsWriteFile).toHaveBeenCalledTimes(1);
    const preparedPackage = mockPrepareAgentCompaniesImport.mock.calls[0]?.[0] as any;
    expect(preparedPackage.agents).toEqual([{ name: "Reviewer", skills: ["review"] }]);
    expect(preparedPackage.skills).toEqual([{ name: "review", description: "Review implementation details" }]);
  });

  it("live import persists skills and returns skill import result", async () => {
    const sourceDir = join(testDir, "skills-live-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
      skills: [
        { name: "review", description: "Review code changes", instructionBody: "# Review\n\nReview instructions" },
        { name: "strategy", description: "Strategic planning" },
      ],
    });

    // Mock fs operations: access returns "not exists" for all skill paths, mkdir and write succeed
    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();
    mockFsAccess.mockRejectedValue(new Error("ENOENT"));
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills).toBeDefined();
    expect(body.skills.imported).toHaveLength(2);
    expect(body.skills.imported[0].name).toBe("review");
    expect(body.skills.imported[0].path).toContain("skills/imported/directory-co/");
    expect(body.skills.skipped).toEqual([]);
    expect(body.skills.errors).toEqual([]);
    expect(mockFsMkdir).toHaveBeenCalled();
    expect(mockFsWriteFile).toHaveBeenCalledTimes(2);
  });

  it("live import skips skills that already exist", async () => {
    const sourceDir = join(testDir, "skills-skipped-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
      skills: [{ name: "review" }],
    });

    // Mock fs: access returns success (file exists)
    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();
    mockFsAccess.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills).toBeDefined();
    expect(body.skills.imported).toEqual([]);
    expect(body.skills.skipped).toEqual(["review"]);
    expect(body.skills.errors).toEqual([]);
    expect(mockFsWriteFile).not.toHaveBeenCalled();
  });

  it("live import handles skill write errors gracefully", async () => {
    const sourceDir = join(testDir, "skills-error-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
      skills: [{ name: "review" }],
    });

    // Mock fs: access returns "not exists", but mkdir fails
    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();
    mockFsAccess.mockRejectedValue(new Error("ENOENT"));
    mockFsMkdir.mockRejectedValue(new Error("Permission denied"));
    mockFsWriteFile.mockResolvedValue(undefined);

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills).toBeDefined();
    expect(body.skills.imported).toEqual([]);
    expect(body.skills.skipped).toEqual([]);
    expect(body.skills.errors).toHaveLength(1);
    expect(body.skills.errors[0].name).toBe("review");
    expect(body.skills.errors[0].error).toContain("Permission denied");
  });

  it("live import uses fallback company slug when not provided", async () => {
    const sourceDir = join(testDir, "no-slug-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co" }, // no slug
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [],
      projects: [],
      tasks: [],
      skills: [{ name: "review" }],
    });

    // Reset and setup mocks
    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();
    mockFsAccess.mockRejectedValue(new Error("ENOENT"));
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills.imported).toBeDefined();
    expect(body.skills.imported.length).toBeGreaterThan(0);
    expect(body.skills.imported[0].path).toContain("skills/imported/unknown-company/");
  });

  it("live import returns empty skills when package has no skills", async () => {
    const sourceDir = join(testDir, "no-skills-live-company");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [{ name: "Engineering" }],
      projects: [],
      tasks: [],
    });

    const response = await postImport(app, { source: sourceDir });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.skills).toBeDefined();
    expect(body.skills.imported).toEqual([]);
    expect(body.skills.skipped).toEqual([]);
    expect(body.skills.errors).toEqual([]);
  });

  it("dry-run does not persist skills", async () => {
    const sourceDir = join(testDir, "dryrun-skills");
    mkdirSync(join(sourceDir, "agents", "ceo"), { recursive: true });
    writeFileSync(join(sourceDir, "agents", "ceo", "AGENTS.md"), "---\nname: CEO\n---\nLead");

    mockParseCompanyDirectory.mockReturnValue({
      company: { name: "Directory Co", slug: "directory-co" },
      agents: [{ name: "Dir Agent", skills: ["review"] }],
      teams: [],
      projects: [],
      tasks: [],
      skills: [{ name: "review" }],
    });

    // Reset mocks to ensure clean state
    mockFsAccess.mockReset();
    mockFsMkdir.mockReset();
    mockFsWriteFile.mockReset();

    const response = await postImport(app, { source: sourceDir, dryRun: true });

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.dryRun).toBe(true);
    // dryRun returns skills preview, not skill import result
    // (skill import result has imported/skipped/errors, preview has name/description)
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills[0]?.name).toBe("review");
    // dryRun should NOT call fs operations
    expect(mockFsWriteFile).not.toHaveBeenCalled();
    expect(mockFsMkdir).not.toHaveBeenCalled();
  });
});

describe("GET /api/agents/companies", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  const originalFetch = globalThis.fetch;

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
    globalThis.fetch = originalFetch;
  });

  it("returns companies when external API succeeds", async () => {
    const mockCompanies = [
      { slug: "test-company", name: "Test Company", tagline: "A test company" },
      { slug: "another-company", name: "Another Company" },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => mockCompanies,
    });

    const response = await request(app, "GET", "/api/agents/companies");

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.companies).toHaveLength(2);
    expect(body.companies[0].slug).toBe("test-company");
    expect(body.error).toBeUndefined();
  });

  it("returns error message when external API is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const response = await request(app, "GET", "/api/agents/companies");

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.companies).toEqual([]);
    expect(body.error).toContain("Failed to fetch companies.sh catalog:");
    expect(body.error).toContain("Network unreachable");
  });

  it("returns error message when external API returns non-JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      json: async () => { throw new Error("Not JSON"); },
    });

    const response = await request(app, "GET", "/api/agents/companies");

    expect(response.status).toBe(200);
    const body = response.body as any;
    expect(body.companies).toEqual([]);
    expect(body.error).toContain("Failed to fetch companies.sh catalog:");
  });

  it("returns 500 when request times out", async () => {
    // Create an AbortError by using a mock that throws with 'aborted' in the message
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const response = await request(app, "GET", "/api/agents/companies");

    expect(response.status).toBe(500);
    const body = response.body as any;
    expect(body.error).toContain("timed out");
  });
});
