/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";
import type { SkillsAdapter } from "../skills-adapter.js";
import { computeSkillId, parseSkillId } from "../skills-adapter.js";

class MockStore extends EventEmitter {
  private rootDir: string;

  constructor(rootDir = "/tmp/fn-skills") {
    super();
    this.rootDir = rootDir;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getFusionDir(): string {
    return `${this.rootDir}/.fusion`;
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }
}

// Mock skills adapter for testing
function createMockSkillsAdapter(overrides?: Partial<SkillsAdapter>): SkillsAdapter {
  return {
    discoverSkills: vi.fn().mockResolvedValue([
      {
        id: "npm%3A%40example%2Fskill::skills/example/SKILL.md",
        name: "example/SKILL.md",
        path: "/tmp/agent/skills/example/SKILL.md",
        relativePath: "skills/example/SKILL.md",
        enabled: true,
        metadata: {
          source: "npm:@example/skill",
          scope: "project",
          origin: "package",
          baseDir: "/tmp/agent/skills/example",
        },
      },
      {
        id: "*::skills/local/SKILL.md",
        name: "local/SKILL.md",
        path: "/tmp/project/.fusion/skills/local/SKILL.md",
        relativePath: "skills/local/SKILL.md",
        enabled: false,
        metadata: {
          source: "*",
          scope: "project",
          origin: "top-level",
          baseDir: "/tmp/project/.fusion",
        },
      },
    ]),
    toggleExecutionSkill: vi.fn().mockImplementation(async (rootDir: string, input: { skillId: string; enabled: boolean }) => {
      if (input.skillId === "unknown") {
        throw new Error(`Invalid skill ID format: unknown`);
      }
      if (input.skillId === "notfound%3A%3A::skills/nonexistent/SKILL.md") {
        throw new Error(`Skill not found: ${input.skillId}`);
      }
      return {
        settingsPath: input.skillId.includes("::") && !input.skillId.startsWith("*::")
          ? "packages[].skills"
          : "skills",
        pattern: input.enabled ? "+skills/example/SKILL.md" : "-skills/example/SKILL.md",
        targetFile: `${rootDir}/.fusion/settings.json`,
      };
    }),
    fetchCatalog: vi.fn().mockResolvedValue({
      entries: [
        {
          id: "example-skill",
          slug: "example-skill",
          name: "Example Skill",
          description: "An example skill",
          tags: ["utility"],
          installs: 100,
          installation: {
            installed: true,
            matchingSkillIds: ["npm%3A%40example%2Fskill::skills/example/SKILL.md"],
            matchingPaths: ["skills/example/SKILL.md"],
          },
        },
        {
          id: "another-skill",
          slug: "another-skill",
          name: "Another Skill",
          description: "Another example skill",
          installation: {
            installed: false,
            matchingSkillIds: [],
            matchingPaths: [],
          },
        },
      ],
      auth: {
        mode: "unauthenticated",
        tokenPresent: false,
        fallbackUsed: false,
      },
    }),
    ...overrides,
  };
}

describe("Skills routes", () => {
  describe("GET /api/skills/discovered", () => {
    it("returns discovered skills from the adapter", async () => {
      const mockAdapter = createMockSkillsAdapter();
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/discovered");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        skills: [
          {
            id: "npm%3A%40example%2Fskill::skills/example/SKILL.md",
            name: "example/SKILL.md",
            path: "/tmp/agent/skills/example/SKILL.md",
            relativePath: "skills/example/SKILL.md",
            enabled: true,
            metadata: {
              source: "npm:@example/skill",
              scope: "project",
              origin: "package",
              baseDir: "/tmp/agent/skills/example",
            },
          },
          {
            id: "*::skills/local/SKILL.md",
            name: "local/SKILL.md",
            path: "/tmp/project/.fusion/skills/local/SKILL.md",
            relativePath: "skills/local/SKILL.md",
            enabled: false,
            metadata: {
              source: "*",
              scope: "project",
              origin: "top-level",
              baseDir: "/tmp/project/.fusion",
            },
          },
        ],
      });
    });

    it("returns 404 when skills adapter is not configured", async () => {
      const store = new MockStore();
      const app = createServer(store as any, {});

      const res = await request(app, "GET", "/api/skills/discovered");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Skills adapter not configured", code: "adapter_not_configured" });
    });

    it("uses scoped store for project context", async () => {
      const mockAdapter = createMockSkillsAdapter({
        discoverSkills: vi.fn().mockResolvedValue([]),
      });
      const store = new MockStore("/tmp/other-project");
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/discovered");

      expect(res.status).toBe(200);
      expect(mockAdapter.discoverSkills).toHaveBeenCalledWith("/tmp/other-project");
    });
  });

  describe("PATCH /api/skills/execution", () => {
    it("toggles skill execution successfully", async () => {
      const mockAdapter = createMockSkillsAdapter();
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(
        app,
        "PATCH",
        "/api/skills/execution",
        JSON.stringify({ skillId: "npm%3A%40example%2Fskill::skills/example/SKILL.md", enabled: true }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        skillId: "npm%3A%40example%2Fskill::skills/example/SKILL.md",
        enabled: true,
        persistence: {
          scope: "project",
          targetFile: expect.stringContaining("/.fusion/settings.json"),
          settingsPath: "packages[].skills",
          pattern: "+skills/example/SKILL.md",
        },
      });
    });

    it("returns 400 with code when skillId is missing", async () => {
      const mockAdapter = createMockSkillsAdapter();
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(
        app,
        "PATCH",
        "/api/skills/execution",
        JSON.stringify({ enabled: true }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "skillId is required", code: "invalid_body" });
    });

    it("returns 400 with code when enabled is not a boolean", async () => {
      const mockAdapter = createMockSkillsAdapter();
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(
        app,
        "PATCH",
        "/api/skills/execution",
        JSON.stringify({ skillId: "test::skill", enabled: "yes" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "enabled must be a boolean", code: "invalid_body" });
    });

    it("returns 404 with code when skills adapter is not configured", async () => {
      const store = new MockStore();
      const app = createServer(store as any, {});

      const res = await request(
        app,
        "PATCH",
        "/api/skills/execution",
        JSON.stringify({ skillId: "test::skill", enabled: true }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Skills adapter not configured", code: "adapter_not_configured" });
    });

    it("returns 400 with code for invalid skill ID format", async () => {
      const mockAdapter = createMockSkillsAdapter({
        toggleExecutionSkill: vi.fn().mockRejectedValue(new Error("Invalid skill ID format: unknown")),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(
        app,
        "PATCH",
        "/api/skills/execution",
        JSON.stringify({ skillId: "unknown", enabled: true }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: expect.stringContaining("Invalid skill ID format"),
        code: "invalid_skill_id",
      });
    });

    it("returns 404 with code when skill not found", async () => {
      const mockAdapter = createMockSkillsAdapter({
        toggleExecutionSkill: vi.fn().mockRejectedValue(new Error("Skill not found: notfound%3A%3A::skills/nonexistent/SKILL.md")),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(
        app,
        "PATCH",
        "/api/skills/execution",
        JSON.stringify({ skillId: "notfound%3A%3A::skills/nonexistent/SKILL.md", enabled: true }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: expect.stringContaining("Skill not found"),
        code: "skill_not_found",
      });
    });
  });

  describe("GET /api/skills/catalog", () => {
    it("returns catalog entries with installation info", async () => {
      const mockAdapter = createMockSkillsAdapter();
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        entries: [
          {
            id: "example-skill",
            slug: "example-skill",
            name: "Example Skill",
            description: "An example skill",
            tags: ["utility"],
            installs: 100,
            installation: {
              installed: true,
              matchingSkillIds: ["npm%3A%40example%2Fskill::skills/example/SKILL.md"],
              matchingPaths: ["skills/example/SKILL.md"],
            },
          },
          {
            id: "another-skill",
            slug: "another-skill",
            name: "Another Skill",
            description: "Another example skill",
            installation: {
              installed: false,
              matchingSkillIds: [],
              matchingPaths: [],
            },
          },
        ],
        auth: {
          mode: "unauthenticated",
          tokenPresent: false,
          fallbackUsed: false,
        },
      });
    });

    it("returns 404 with code when skills adapter is not configured", async () => {
      const store = new MockStore();
      const app = createServer(store as any, {});

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Skills adapter not configured", code: "adapter_not_configured" });
    });

    it("passes limit and query parameters to catalog fetch", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          entries: [],
          auth: { mode: "unauthenticated", tokenPresent: false, fallbackUsed: false },
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog?limit=50&q=search-term");

      expect(res.status).toBe(200);
      expect(mockAdapter.fetchCatalog).toHaveBeenCalledWith({ limit: 50, query: "search-term" });
    });

    it("bounds limit parameter to max 100", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          entries: [],
          auth: { mode: "unauthenticated", tokenPresent: false, fallbackUsed: false },
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog?limit=500");

      expect(res.status).toBe(200);
      expect(mockAdapter.fetchCatalog).toHaveBeenCalledWith({ limit: 100, query: undefined });
    });

    it("returns 502 for upstream errors", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          error: "Upstream request timed out",
          code: "upstream_timeout",
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: "Upstream request timed out",
        code: "upstream_timeout",
      });
    });

    it("returns 502 for upstream_http_error", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          error: "Upstream returned 500: Internal Server Error",
          code: "upstream_http_error",
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        error: expect.stringContaining("Upstream"),
        code: "upstream_http_error",
      });
    });

    it("returns 502 for upstream_invalid_payload", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          error: "Invalid upstream response format",
          code: "upstream_invalid_payload",
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        error: expect.stringContaining("Invalid"),
        code: "upstream_invalid_payload",
      });
    });
  });

  describe("GET /api/skills/catalog - auth modes", () => {
    it("returns authenticated mode when adapter reports authenticated success", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          entries: [{ id: "auth-skill", slug: "auth-skill", name: "Auth Skill", installation: { installed: false, matchingSkillIds: [], matchingPaths: [] } }],
          auth: {
            mode: "authenticated",
            tokenPresent: true,
            fallbackUsed: false,
          },
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(200);
      expect(res.body.auth.mode).toBe("authenticated");
      expect(res.body.auth.tokenPresent).toBe(true);
      expect(res.body.auth.fallbackUsed).toBe(false);
    });

    it("returns unauthenticated mode when adapter reports direct unauthenticated request", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          entries: [{ id: "public-skill", slug: "public-skill", name: "Public Skill", installation: { installed: false, matchingSkillIds: [], matchingPaths: [] } }],
          auth: {
            mode: "unauthenticated",
            tokenPresent: false,
            fallbackUsed: false,
          },
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(200);
      expect(res.body.auth.mode).toBe("unauthenticated");
      expect(res.body.auth.tokenPresent).toBe(false);
      expect(res.body.auth.fallbackUsed).toBe(false);
    });

    it("returns fallback-unauthenticated mode when adapter falls back from auth to unauthenticated", async () => {
      // This simulates 401/403 from authenticated request, followed by successful unauthenticated fallback
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          entries: [{ id: "fallback-skill", slug: "fallback-skill", name: "Fallback Skill", installation: { installed: false, matchingSkillIds: [], matchingPaths: [] } }],
          auth: {
            mode: "fallback-unauthenticated",
            tokenPresent: true,
            fallbackUsed: true,
          },
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(200);
      expect(res.body.auth.mode).toBe("fallback-unauthenticated");
      expect(res.body.auth.tokenPresent).toBe(true);
      expect(res.body.auth.fallbackUsed).toBe(true);
    });

    it("passes catalog entries through with correct structure", async () => {
      const mockAdapter = createMockSkillsAdapter({
        fetchCatalog: vi.fn().mockResolvedValue({
          entries: [
            {
              id: "skill-1",
              slug: "skill-1",
              name: "Skill One",
              description: "First skill",
              repo: "github.com/user/skill-1",
              npmPackage: "@example/skill-1",
              tags: ["utility", "productivity"],
              installs: 1500,
              installation: {
                installed: true,
                matchingSkillIds: ["pkg::skills/skill-1/SKILL.md"],
                matchingPaths: ["skills/skill-1/SKILL.md"],
              },
            },
            {
              id: "skill-2",
              slug: "skill-2",
              name: "Skill Two",
              installation: {
                installed: false,
                matchingSkillIds: [],
                matchingPaths: [],
              },
            },
          ],
          auth: {
            mode: "unauthenticated",
            tokenPresent: false,
            fallbackUsed: false,
          },
        }),
      });
      const store = new MockStore();
      const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

      const res = await request(app, "GET", "/api/skills/catalog");

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.entries[0]).toMatchObject({
        id: "skill-1",
        slug: "skill-1",
        name: "Skill One",
        description: "First skill",
        repo: "github.com/user/skill-1",
        npmPackage: "@example/skill-1",
        tags: ["utility", "productivity"],
        installs: 1500,
        installation: {
          installed: true,
          matchingSkillIds: ["pkg::skills/skill-1/SKILL.md"],
          matchingPaths: ["skills/skill-1/SKILL.md"],
        },
      });
      expect(res.body.entries[1]).toMatchObject({
        id: "skill-2",
        slug: "skill-2",
        name: "Skill Two",
        installation: {
          installed: false,
          matchingSkillIds: [],
          matchingPaths: [],
        },
      });
    });
  });
});

describe("Skill ID computation", () => {
  it("computes deterministic skill ID from source and relativePath", () => {
    // Format: encodeURIComponent(metadata.source) + "::" + relativePath.replaceAll("\\", "/")
    const skillId = computeSkillId("npm:@example/skill", "skills/foo/SKILL.md");
    expect(skillId).toBe("npm%3A%40example%2Fskill::skills/foo/SKILL.md");
  });

  it("normalizes backslashes to forward slashes in path", () => {
    const skillId = computeSkillId("npm:pkg", "skills\\sub\\SKILL.md");
    expect(skillId).toBe("npm%3Apkg::skills/sub/SKILL.md");
  });

  it("parses skill ID back into source and relativePath", () => {
    const skillId = "npm%3A%40example%2Fskill::skills/foo/SKILL.md";
    const parsed = parseSkillId(skillId);
    expect(parsed).toEqual({
      source: "npm:@example/skill",
      relativePath: "skills/foo/SKILL.md",
    });
  });

  it("returns null for invalid skill ID format", () => {
    expect(parseSkillId("invalid")).toBeNull();
    expect(parseSkillId("no-colon-here")).toBeNull();
  });

  it("handles top-level skills with wildcard source", () => {
    const skillId = computeSkillId("*", "skills/local/SKILL.md");
    expect(skillId).toBe("*::skills/local/SKILL.md");

    const parsed = parseSkillId(skillId);
    expect(parsed).toEqual({
      source: "*",
      relativePath: "skills/local/SKILL.md",
    });
  });
});

describe("PATCH /api/skills/execution - toggle semantics", () => {
  it("uses top-level pattern for source='*' skills", async () => {
    // When source is "*", the pattern should mutate settings.skills
    const mockAdapter = createMockSkillsAdapter({
      toggleExecutionSkill: vi.fn().mockImplementation(async (rootDir: string, input: { skillId: string; enabled: boolean }) => {
        const parsed = parseSkillId(input.skillId);
        const isTopLevel = parsed?.source === "*";
        return {
          settingsPath: isTopLevel ? "skills" : "packages[].skills",
          pattern: input.enabled ? "+skills/foo/SKILL.md" : "-skills/foo/SKILL.md",
          targetFile: `${rootDir}/.fusion/settings.json`,
        };
      }),
    });
    const store = new MockStore();
    const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

    const res = await request(
      app,
      "PATCH",
      "/api/skills/execution",
      JSON.stringify({ skillId: "*::skills/foo/SKILL.md", enabled: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.persistence.settingsPath).toBe("skills");
  });

  it("uses package pattern for non-wildcard source skills", async () => {
    const mockAdapter = createMockSkillsAdapter({
      toggleExecutionSkill: vi.fn().mockImplementation(async (rootDir: string, input: { skillId: string; enabled: boolean }) => {
        const parsed = parseSkillId(input.skillId);
        const isTopLevel = parsed?.source === "*";
        return {
          settingsPath: isTopLevel ? "skills" : "packages[].skills",
          pattern: input.enabled ? "+skills/foo/SKILL.md" : "-skills/foo/SKILL.md",
          targetFile: `${rootDir}/.fusion/settings.json`,
        };
      }),
    });
    const store = new MockStore();
    const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

    const res = await request(
      app,
      "PATCH",
      "/api/skills/execution",
      JSON.stringify({ skillId: "npm%3A%40example%2Fskill::skills/foo/SKILL.md", enabled: false }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body.persistence.settingsPath).toBe("packages[].skills");
  });

  it("returns 400 with code when skillId is empty string", async () => {
    const mockAdapter = createMockSkillsAdapter();
    const store = new MockStore();
    const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

    const res = await request(
      app,
      "PATCH",
      "/api/skills/execution",
      JSON.stringify({ skillId: "", enabled: true }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "skillId is required", code: "invalid_body" });
  });

  it("returns 400 with code when enabled is undefined", async () => {
    const mockAdapter = createMockSkillsAdapter();
    const store = new MockStore();
    const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

    const res = await request(
      app,
      "PATCH",
      "/api/skills/execution",
      JSON.stringify({ skillId: "test::skill" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("preserves response shape for top-level and package skills", async () => {
    // Verify the response shape is consistent regardless of skill type
    const mockAdapter = createMockSkillsAdapter({
      toggleExecutionSkill: vi.fn().mockImplementation(async (rootDir: string, input: { skillId: string; enabled: boolean }) => {
        return {
          settingsPath: input.skillId.startsWith("*::") ? "skills" : "packages[].skills",
          pattern: input.enabled ? "+path" : "-path",
          targetFile: `${rootDir}/.fusion/settings.json`,
        };
      }),
    });
    const store = new MockStore();
    const app = createServer(store as any, { skillsAdapter: mockAdapter as SkillsAdapter });

    // Test top-level skill
    const res1 = await request(
      app,
      "PATCH",
      "/api/skills/execution",
      JSON.stringify({ skillId: "*::skill", enabled: true }),
      { "Content-Type": "application/json" },
    );
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({
      success: true,
      skillId: "*::skill",
      enabled: true,
      persistence: {
        scope: "project",
        settingsPath: "skills",
      },
    });

    // Test package skill
    const res2 = await request(
      app,
      "PATCH",
      "/api/skills/execution",
      JSON.stringify({ skillId: "npm%3Apkg::skill", enabled: false }),
      { "Content-Type": "application/json" },
    );
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({
      success: true,
      skillId: "npm%3Apkg::skill",
      enabled: false,
      persistence: {
        scope: "project",
        settingsPath: "packages[].skills",
      },
    });
  });
});
