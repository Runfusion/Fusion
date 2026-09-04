// @vitest-environment node

import express from "express";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { createSkillsAdapter, type SkillsAdapter } from "../../skills-adapter.js";
import { request } from "../../test-request.js";

function createStore(rootDir = "/tmp/skills-project") {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    getRootDir: vi.fn().mockReturnValue(rootDir),
    getFusionDir: vi.fn().mockReturnValue(`${rootDir}/.fusion`),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

function createMockSkillsAdapter(overrides?: Partial<SkillsAdapter>): SkillsAdapter {
  return {
    discoverSkills: vi.fn().mockResolvedValue([]),
    toggleExecutionSkill: vi.fn(),
    installSkill: vi.fn().mockResolvedValue({ success: true }),
    fetchCatalog: vi.fn().mockResolvedValue({
      entries: [],
      auth: { mode: "unauthenticated", tokenPresent: false, fallbackUsed: false },
    }),
    readSkillContent: vi.fn(),
    readSkillFileContent: vi.fn(),
    ...overrides,
  } as SkillsAdapter;
}

function app(skillsAdapter?: SkillsAdapter, rootDir?: string) {
  const server = express();
  server.use(express.json());
  server.use("/api", createApiRoutes(createStore(rootDir), { skillsAdapter }));
  return server;
}

describe("register-agent-skills-routes", () => {
  const temporaryRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("GET /api/skills/catalog resolves the selected project's root", async () => {
    const skillsAdapter = createMockSkillsAdapter();
    const res = await request(app(skillsAdapter, "/tmp/project-a"), "GET", "/api/skills/catalog");

    expect(res.status).toBe(200);
    expect(skillsAdapter.fetchCatalog).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: "/tmp/project-a",
      projectStore: expect.objectContaining({ getRootDir: expect.any(Function) }),
    }));
  });

  it("keeps two projects isolated across discovery, installation, and execution settings", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "fn-skills-route-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "fn-skills-route-b-"));
    temporaryRoots.push(rootA, rootB);
    const onlyA = join(rootA, ".pi", "skills", "only-a", "SKILL.md");
    const onlyB = join(rootB, ".pi", "skills", "only-b", "SKILL.md");
    const shared = join(tmpdir(), "fn-skills-route-shared", "SKILL.md");
    await Promise.all([
      mkdir(join(onlyA, ".."), { recursive: true }).then(() => writeFile(onlyA, "# only-a")),
      mkdir(join(onlyB, ".."), { recursive: true }).then(() => writeFile(onlyB, "# only-b")),
      mkdir(join(rootB, ".fusion"), { recursive: true }).then(() => writeFile(
        join(rootB, ".fusion", "settings.json"),
        JSON.stringify({ skills: ["-skills/only-b/SKILL.md"] }),
      )),
    ]);

    let installedInA = false;
    const factoryRoots: string[] = [];
    const resolvedRoots: string[] = [];
    const adapter = createSkillsAdapter({
      getPackageManager: (rootDir) => {
        factoryRoots.push(rootDir);
        return {
        resolve: vi.fn(async () => {
          resolvedRoots.push(rootDir);
          const installed = join(rootDir, ".pi", "skills", "using-superpowers", "SKILL.md");
          const paths = rootDir === rootA
            ? [onlyA, ...(installedInA ? [installed] : [])]
            : rootDir === rootB ? [onlyB] : [];
          return {
            skills: [...paths, shared].map((path) => ({
              path,
              enabled: true,
              metadata: { source: "*", scope: "project" as const, origin: "top-level" as const, baseDir: join(rootDir, ".pi") },
            })),
          };
        }),
        };
      },
      getSettingsPath: (rootDir) => join(rootDir, ".fusion", "settings.json"),
      superviseSpawn: vi.fn((_command, _args, options) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        return {
          child,
          waitExit: async () => {
            const installed = join(options.cwd!, ".pi", "skills", "using-superpowers", "SKILL.md");
            await mkdir(join(installed, ".."), { recursive: true });
            await writeFile(installed, "# using-superpowers");
            installedInA = true;
            child.stdout.end();
            child.stderr.end();
            return { code: 0, signal: null };
          },
        } as any;
      }),
    });
    const storeA = createStore(rootA);
    const storeB = createStore(rootB);
    const server = express();
    server.use(express.json());
    server.use("/api", createApiRoutes(storeA, {
      skillsAdapter: adapter,
      engineManager: {
        getEngine: (projectId: string) => projectId === "A"
          ? { getTaskStore: () => storeA }
          : projectId === "B" ? { getTaskStore: () => storeB } : undefined,
      },
    } as any));

    const directA = await adapter.discoverSkills(rootA);
    expect(factoryRoots).toContain(rootA);
    expect(resolvedRoots).toContain(rootA);
    expect(directA.map((skill) => skill.name)).toContain("only-a/SKILL.md");
    const discoveredA = await request(server, "GET", "/api/skills/discovered?projectId=A");
    const discoveredB = await request(server, "GET", "/api/skills/discovered?projectId=B");
    expect(discoveredA.status).toBe(200);
    expect(discoveredB.status).toBe(200);
    const namesA = discoveredA.body.skills.map((skill: { name: string }) => skill.name);
    const namesB = discoveredB.body.skills.map((skill: { name: string }) => skill.name);
    expect(namesA).toContain("only-a/SKILL.md");
    expect(namesA).not.toContain("only-b/SKILL.md");
    expect(namesB).toContain("only-b/SKILL.md");
    expect(namesB).not.toContain("only-a/SKILL.md");
    expect(namesA.filter((name: string) => namesB.includes(name))).toHaveLength(1);

    const install = await request(server, "POST", "/api/skills/install?projectId=A", JSON.stringify({ source: "owner/repo", skill: "using-superpowers" }), { "Content-Type": "application/json" });
    expect(install.status).toBe(200);
    const afterInstallA = await request(server, "GET", "/api/skills/discovered?projectId=A");
    const afterInstallB = await request(server, "GET", "/api/skills/discovered?projectId=B");
    expect(afterInstallA.body.skills.map((skill: { name: string }) => skill.name)).toContain("using-superpowers/SKILL.md");
    expect(afterInstallB.body.skills.map((skill: { name: string }) => skill.name)).not.toContain("using-superpowers/SKILL.md");

    const aSkill = afterInstallA.body.skills.find((skill: { name: string }) => skill.name === "only-a/SKILL.md");
    const toggle = await request(server, "PATCH", "/api/skills/execution?projectId=A", JSON.stringify({ skillId: aSkill.id, enabled: true }), { "Content-Type": "application/json" });
    expect(toggle.status).toBe(200);
    expect(JSON.parse(await readFile(join(rootA, ".fusion", "settings.json"), "utf8")).skills).toContain("+only-a/SKILL.md");
    expect(JSON.parse(await readFile(join(rootB, ".fusion", "settings.json"), "utf8"))).toEqual({ skills: ["-skills/only-b/SKILL.md"] });
  });

  it("POST /api/skills/install installs a skill", async () => {
    const skillsAdapter = createMockSkillsAdapter({
      installSkill: vi.fn().mockResolvedValue({ success: true }),
    });

    const res = await request(
      app(skillsAdapter, "/tmp/install-root"),
      "POST",
      "/api/skills/install",
      JSON.stringify({ source: "owner/repo", skill: "skill-name" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(skillsAdapter.installSkill).toHaveBeenCalledWith({
      source: "owner/repo",
      skill: "skill-name",
      cwd: "/tmp/install-root",
    });
  });

  it("POST /api/skills/install returns 400 for missing source", async () => {
    const skillsAdapter = createMockSkillsAdapter();

    const res = await request(
      app(skillsAdapter),
      "POST",
      "/api/skills/install",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "source is required", code: "invalid_body" });
  });

  it("POST /api/skills/install returns 400 for malformed source", async () => {
    const skillsAdapter = createMockSkillsAdapter();

    const res = await request(
      app(skillsAdapter),
      "POST",
      "/api/skills/install",
      JSON.stringify({ source: "bad" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid source format. Use owner/repo.",
      code: "invalid_source",
    });
    expect(skillsAdapter.installSkill).not.toHaveBeenCalled();
  });

  it("POST /api/skills/install returns 404 without a skills adapter", async () => {
    const res = await request(
      app(undefined),
      "POST",
      "/api/skills/install",
      JSON.stringify({ source: "owner/repo" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Skills adapter not configured",
      code: "adapter_not_configured",
    });
  });

  it("POST /api/skills/install returns 502 for structured adapter errors", async () => {
    const skillsAdapter = createMockSkillsAdapter({
      installSkill: vi.fn().mockResolvedValue({
        error: "installer failed",
        code: "install_failed",
      }),
    });

    const res = await request(
      app(skillsAdapter),
      "POST",
      "/api/skills/install",
      JSON.stringify({ source: "owner/repo" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "installer failed", code: "install_failed" });
  });

  // FNXC:Skills 2026-06-23-04:15: per-file content endpoint backing the detail-pane file viewer.
  it("GET /api/skills/:id/file returns a file's content", async () => {
    const skillsAdapter = createMockSkillsAdapter({
      readSkillFileContent: vi.fn().mockResolvedValue({
        name: "reference.md",
        relativePath: "reference.md",
        content: "# Ref",
        isText: true,
      }),
    });

    const res = await request(
      app(skillsAdapter, "/tmp/file-root"),
      "GET",
      "/api/skills/npm%3A%3Askills%2Ftest-skill/file?path=reference.md",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file: { name: "reference.md", relativePath: "reference.md", content: "# Ref", isText: true },
    });
    expect(skillsAdapter.readSkillFileContent).toHaveBeenCalledWith(
      "/tmp/file-root",
      "npm::skills/test-skill",
      "reference.md",
      expect.objectContaining({ getRootDir: expect.any(Function) }),
    );
  });

  it("GET /api/skills/:id/file returns 400 when path is missing", async () => {
    const skillsAdapter = createMockSkillsAdapter();

    const res = await request(
      app(skillsAdapter),
      "GET",
      "/api/skills/npm%3A%3Askills%2Ftest-skill/file",
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "path is required", code: "invalid_path" });
    expect(skillsAdapter.readSkillFileContent).not.toHaveBeenCalled();
  });

  it("GET /api/skills/:id/file returns 404 when the file is missing", async () => {
    const skillsAdapter = createMockSkillsAdapter({
      readSkillFileContent: vi.fn().mockRejectedValue(new Error("Skill file not found: nope.md")),
    });

    const res = await request(
      app(skillsAdapter),
      "GET",
      "/api/skills/npm%3A%3Askills%2Ftest-skill/file?path=nope.md",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Skill file not found", code: "skill_file_not_found" });
  });

  it("GET /api/skills/:id/file returns 400 for a traversal path", async () => {
    const skillsAdapter = createMockSkillsAdapter({
      readSkillFileContent: vi.fn().mockRejectedValue(new Error("Invalid skill file path: ../secret")),
    });

    const res = await request(
      app(skillsAdapter),
      "GET",
      "/api/skills/npm%3A%3Askills%2Ftest-skill/file?path=..%2Fsecret",
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid skill file path: ../secret", code: "invalid_path" });
  });

  it("GET /api/skills/:id/file returns 404 without a skills adapter", async () => {
    const res = await request(
      app(undefined),
      "GET",
      "/api/skills/npm%3A%3Askills%2Ftest-skill/file?path=reference.md",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Skills adapter not configured", code: "adapter_not_configured" });
  });
});
