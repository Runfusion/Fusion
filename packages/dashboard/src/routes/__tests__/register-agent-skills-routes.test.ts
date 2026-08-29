// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";
import type { SkillsAdapter } from "../../skills-adapter.js";

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

function createSkillsAdapter(overrides?: Partial<SkillsAdapter>): SkillsAdapter {
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/skills/install installs a skill", async () => {
    const skillsAdapter = createSkillsAdapter({
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
    const skillsAdapter = createSkillsAdapter();

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
    const skillsAdapter = createSkillsAdapter();

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
    const skillsAdapter = createSkillsAdapter({
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
    const skillsAdapter = createSkillsAdapter({
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
    const skillsAdapter = createSkillsAdapter();

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
    const skillsAdapter = createSkillsAdapter({
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
    const skillsAdapter = createSkillsAdapter({
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
