import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSkillsAdapter, extractSkillName } from "../skills-adapter.js";
import { writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

describe("createSkillsAdapter - fetchCatalog fallback behavior", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SKILLS_SH_TOKEN;
  });

  it("falls back to public search endpoint when authenticated endpoint returns 400", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [{ id: "s1", name: "Found Skill", skillId: "s1" }],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Found Skill");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });

  it("falls back to public search endpoint on 401", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [{ id: "s2", name: "Fallback Skill", skillId: "s2" }],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Fallback Skill");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });

  it("falls back to public search endpoint on 403", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [{ id: "s3", name: "Forbidden Fallback", skillId: "s3" }],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Forbidden Fallback");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });

  it("returns UpstreamError when authenticated endpoint returns 500", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.resolve(null),
        });
      }
      // This should NOT be called
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(1);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.code).toBe("upstream_http_error");
      expect(result.error).toContain("500");
    }
  });

  it("uses public search endpoint when no token is present", async () => {
    // Ensure no token
    delete process.env.SKILLS_SH_TOKEN;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: () =>
        Promise.resolve({
          skills: [{ id: "s4", name: "Public Skill", skillId: "s4" }],
        }),
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Public Skill");
      expect(result.auth.tokenPresent).toBe(false);
      expect(result.auth.fallbackUsed).toBe(false);
    }
  });

  it.each([undefined, "", "a"]) (
    "returns empty success result without upstream call when unauthenticated query is short (%s)",
    async (query) => {
      delete process.env.SKILLS_SH_TOKEN;

      globalThis.fetch = vi.fn();

      const adapter = createSkillsAdapter({
        packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
        getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
      });

      const result = await adapter.fetchCatalog({ limit: 20, query });

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect("entries" in result).toBe(true);
      if ("entries" in result) {
        expect(result.entries).toEqual([]);
        expect(result.auth).toEqual({
          mode: "unauthenticated",
          tokenPresent: false,
          fallbackUsed: false,
        });
      }
    },
  );

  it.each([400, 401, 403])(
    "returns empty success fallback when auth request fails with %i and query is short",
    async (status) => {
      process.env.SKILLS_SH_TOKEN = "test-token";

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: "Bad Request",
        json: () => Promise.resolve(null),
      }) as unknown as typeof fetch;

      const adapter = createSkillsAdapter({
        packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
        getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
      });

      const result = await adapter.fetchCatalog({ limit: 20, query: "a" });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect("entries" in result).toBe(true);
      if ("entries" in result) {
        expect(result.entries).toEqual([]);
        expect(result.auth).toEqual({
          mode: "fallback-unauthenticated",
          tokenPresent: true,
          fallbackUsed: true,
        });
      }
    },
  );

  it("keeps fallback public search behavior for valid queries", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: () => Promise.resolve(null),
        });
      }

      expect(urlStr).toContain("/api/search");
      expect(urlStr).toContain("q=react");
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () => Promise.resolve({ skills: [{ id: "search-1", name: "React Skill" }] }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "react" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("React Skill");
      expect(result.auth.mode).toBe("fallback-unauthenticated");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });
});

describe("createSkillsAdapter - readSkillContent", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function createMockSkillDir(skillMdContent?: string, extraFiles?: string[]) {
    const skillDir = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(skillDir, { recursive: true });

    if (skillMdContent !== undefined) {
      await writeFile(join(skillDir, "SKILL.md"), skillMdContent, "utf-8");
    }

    if (extraFiles) {
      for (const file of extraFiles) {
        const filePath = join(skillDir, file);
        const fileDir = dirname(filePath);
        if (!await access(fileDir).then(() => true).catch(() => false)) {
          await mkdir(fileDir, { recursive: true });
        }
        await writeFile(filePath, `content of ${file}`, "utf-8");
      }
    }

    return skillDir;
  }

  async function cleanup(skillDir: string) {
    try {
      await rm(skillDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  it("returns SKILL.md content and file listing for a valid skill", async () => {
    const skillDir = await createMockSkillDir(
      "# Test Skill\n\nThis is a test skill.",
      ["references/ref.md", "workflows/test.sh"]
    );

    const adapter = createSkillsAdapter({
      packageManager: {
        resolve: vi.fn().mockResolvedValue({ skills: [] }),
      },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    // Spy on discoverSkills to return a controlled skill
    const mockDiscoveredSkill = {
      id: "npm::skills/test-skill",
      name: "test-skill",
      path: join(skillDir, "SKILL.md"),
      relativePath: "skills/test-skill",
      enabled: true,
      metadata: {
        source: "npm",
        scope: "project" as const,
        origin: "top-level" as const,
        baseDir: skillDir,
      },
    };

    vi.spyOn(adapter, "discoverSkills").mockResolvedValue([mockDiscoveredSkill]);

    const result = await adapter.readSkillContent("/project", "npm::skills/test-skill");

    expect(result.name).toBe("test-skill");
    expect(result.skillMd).toBe("# Test Skill\n\nThis is a test skill.");
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.name).sort()).toEqual(["references", "workflows"]);
    expect(result.files.find((f) => f.name === "references")!.type).toBe("directory");
    expect(result.files.find((f) => f.name === "workflows")!.type).toBe("directory");

    await cleanup(skillDir);
  });

  it("returns empty skillMd when SKILL.md doesn't exist", async () => {
    const skillDir = await createMockSkillDir(undefined, ["readme.txt"]);

    const adapter = createSkillsAdapter({
      packageManager: {
        resolve: vi.fn().mockResolvedValue({ skills: [] }),
      },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const mockDiscoveredSkill = {
      id: "npm::skills/test-skill",
      name: "test-skill",
      path: skillDir,
      relativePath: "skills/test-skill",
      enabled: true,
      metadata: {
        source: "npm",
        scope: "project" as const,
        origin: "top-level" as const,
      },
    };

    vi.spyOn(adapter, "discoverSkills").mockResolvedValue([mockDiscoveredSkill]);

    const result = await adapter.readSkillContent("/project", "npm::skills/test-skill");

    expect(result.name).toBe("test-skill");
    expect(result.skillMd).toBe("");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe("readme.txt");

    await cleanup(skillDir);
  });

  it("throws error for invalid skill ID format", async () => {
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    await expect(adapter.readSkillContent("/project", "invalid-skill-id")).rejects.toThrow(
      "Invalid skill ID format"
    );
  });

  it("throws error for non-existent skill", async () => {
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    await expect(adapter.readSkillContent("/project", "npm::skills/nonexistent")).rejects.toThrow(
      "Skill not found"
    );
  });

  it("filters out SKILL.md from supplementary files listing", async () => {
    const skillDir = await createMockSkillDir(
      "# Test Skill",
      ["SKILL.md", "readme.txt"]
    );

    const adapter = createSkillsAdapter({
      packageManager: {
        resolve: vi.fn().mockResolvedValue({ skills: [] }),
      },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const mockDiscoveredSkill = {
      id: "npm::skills/test-skill",
      name: "test-skill",
      path: join(skillDir, "SKILL.md"),
      relativePath: "skills/test-skill",
      enabled: true,
      metadata: {
        source: "npm",
        scope: "project" as const,
        origin: "top-level" as const,
      },
    };

    vi.spyOn(adapter, "discoverSkills").mockResolvedValue([mockDiscoveredSkill]);

    const result = await adapter.readSkillContent("/project", "npm::skills/test-skill");

    // Should only have readme.txt, not SKILL.md
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe("readme.txt");

    await cleanup(skillDir);
  });

  it("handles skill path that is already a directory", async () => {
    const skillDir = await createMockSkillDir(
      "# Test Skill",
      ["readme.txt"]
    );

    const adapter = createSkillsAdapter({
      packageManager: {
        resolve: vi.fn().mockResolvedValue({ skills: [] }),
      },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const mockDiscoveredSkill = {
      id: "npm::skills/test-skill",
      name: "test-skill",
      path: skillDir, // Path is already a directory
      relativePath: "skills/test-skill",
      enabled: true,
      metadata: {
        source: "npm",
        scope: "project" as const,
        origin: "top-level" as const,
      },
    };

    vi.spyOn(adapter, "discoverSkills").mockResolvedValue([mockDiscoveredSkill]);

    const result = await adapter.readSkillContent("/project", "npm::skills/test-skill");

    expect(result.name).toBe("test-skill");
    expect(result.skillMd).toBe("# Test Skill");
    expect(result.files).toHaveLength(1);

    await cleanup(skillDir);
  });
});

describe("extractSkillName", () => {
  it("normalizes Windows separators before deriving the display name", () => {
    expect(extractSkillName("skills\\tooling\\windows-fix", "npm")).toBe("tooling/windows-fix");
    expect(extractSkillName("windows-fix", "npm")).toBe("windows-fix");
  });
});
