import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSkillsAdapter, extractSkillName, computeSkillId, bareSkillName } from "../skills-adapter.js";
import { resolvePluginSkillEnabled } from "@fusion/core";
import { writeFile, mkdir, access, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

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

describe("createSkillsAdapter - toggleExecutionSkill persistence", () => {
  async function createRoundTripFixture(source: string) {
    const rootDir = join(tmpdir(), `skills-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const baseDir = source === "*" ? rootDir : join(rootDir, "packages", "example-package");
    const relativePath = "skills/test-skill/SKILL.md";
    const absolutePath = join(baseDir, relativePath);
    const settingsPath = join(rootDir, ".fusion", "settings.json");

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "# Test Skill\n", "utf-8");

    const adapter = createSkillsAdapter({
      packageManager: {
        resolve: vi.fn().mockResolvedValue({
          skills: [
            {
              path: absolutePath,
              enabled: false,
              metadata: {
                source,
                scope: "project" as const,
                origin: source === "*" ? "top-level" as const : "package" as const,
                baseDir,
              },
            },
          ],
        }),
      },
      getSettingsPath: vi.fn().mockReturnValue(settingsPath),
    });

    return {
      adapter,
      rootDir,
      settingsPath,
      skillId: computeSkillId(source, relativePath),
      cleanup: () => rm(rootDir, { recursive: true, force: true }),
    };
  }

  it.each([
    { source: "*", settingsKey: "skills", expectedPattern: "+test-skill/SKILL.md" },
    { source: "@scope/pkg", settingsKey: "packages[].skills", expectedPattern: "+test-skill/SKILL.md" },
  ])("round-trips enabled skills for source $source", async ({ source, settingsKey, expectedPattern }) => {
    const fixture = await createRoundTripFixture(source);

    try {
      const result = await fixture.adapter.toggleExecutionSkill(fixture.rootDir, {
        skillId: fixture.skillId,
        enabled: true,
      });

      expect(result.pattern).toBe(expectedPattern);
      expect(result.settingsPath).toBe(settingsKey);

      const settings = JSON.parse(await readFile(fixture.settingsPath, "utf-8")) as {
        skills?: string[];
        packages?: Array<{ source: string; skills?: string[] }>;
      };

      if (source === "*") {
        expect(settings.skills).toContain(expectedPattern);
      } else {
        expect(settings.packages).toContainEqual({ source, skills: [expectedPattern] });
      }

      const discovered = await fixture.adapter.discoverSkills(fixture.rootDir);
      expect(discovered).toContainEqual(
        expect.objectContaining({ id: fixture.skillId, enabled: true }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    { source: "*", settingsKey: "skills", expectedPattern: "-test-skill/SKILL.md" },
    { source: "@scope/pkg", settingsKey: "packages[].skills", expectedPattern: "-test-skill/SKILL.md" },
  ])("round-trips disabled skills for source $source", async ({ source, settingsKey, expectedPattern }) => {
    const fixture = await createRoundTripFixture(source);

    try {
      const result = await fixture.adapter.toggleExecutionSkill(fixture.rootDir, {
        skillId: fixture.skillId,
        enabled: false,
      });

      expect(result.pattern).toBe(expectedPattern);
      expect(result.settingsPath).toBe(settingsKey);

      const settings = JSON.parse(await readFile(fixture.settingsPath, "utf-8")) as {
        skills?: string[];
        packages?: Array<{ source: string; skills?: string[] }>;
      };

      if (source === "*") {
        expect(settings.skills).toContain(expectedPattern);
      } else {
        expect(settings.packages).toContainEqual({ source, skills: [expectedPattern] });
      }

      const discovered = await fixture.adapter.discoverSkills(fixture.rootDir);
      expect(discovered).toContainEqual(
        expect.objectContaining({ id: fixture.skillId, enabled: false }),
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("createSkillsAdapter - installSkill", () => {
  it("short-circuits invalid source without spawning", async () => {
    const superviseSpawnMock = vi.fn();
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
      superviseSpawn: superviseSpawnMock as never,
    });

    const result = await adapter.installSkill({ source: "invalid", cwd: "/tmp/project" });

    expect(result).toEqual({
      error: "Invalid source format. Use owner/repo.",
      code: "invalid_source",
    });
    expect(superviseSpawnMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "without a specific skill",
      input: { source: "owner/repo", cwd: "/tmp/project" },
      expectedArgs: ["skills", "add", "owner/repo", "-y", "-a", "pi"],
    },
    {
      name: "with a specific skill",
      input: { source: "owner/repo", skill: "my-skill", cwd: "/tmp/project" },
      expectedArgs: ["skills", "add", "owner/repo", "--skill", "my-skill", "-y", "-a", "pi"],
    },
  ])("spawns npx skills add $name", async ({ input, expectedArgs }) => {
    const superviseSpawnMock = vi.fn((_command: string, _args: string[]) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: number;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.pid = 4242;
      process.nextTick(() => {
        stdout.end();
        stderr.end();
      });
      return {
        pid: 4242,
        pgid: null,
        child,
        kill: vi.fn(),
        waitExit: () => Promise.resolve({ code: 0, signal: null }),
      };
    });
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
      superviseSpawn: superviseSpawnMock as never,
    });

    const result = await adapter.installSkill(input);

    expect(result).toEqual({ success: true });
    expect(superviseSpawnMock).toHaveBeenCalledWith(
      "npx",
      expectedArgs,
      expect.objectContaining({
        cwd: "/tmp/project",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        maxLifetimeMs: 60_000,
      }),
    );
  });

  it("returns install_failed when the installer exits non-zero", async () => {
    const superviseSpawnMock = vi.fn(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: number;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.pid = 4242;
      process.nextTick(() => {
        stderr.write("install failed\n");
        stdout.end();
        stderr.end();
      });
      return {
        pid: 4242,
        pgid: null,
        child,
        kill: vi.fn(),
        waitExit: () => Promise.resolve({ code: 1, signal: null }),
      };
    });
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
      superviseSpawn: superviseSpawnMock as never,
    });

    const result = await adapter.installSkill({ source: "owner/repo", cwd: "/tmp/project" });

    expect(result).toEqual({ error: "install failed", code: "install_failed" });
  });
});

describe("extractSkillName", () => {
  it("normalizes Windows separators before deriving the display name", () => {
    expect(extractSkillName("skills\\tooling\\windows-fix", "npm")).toBe("tooling/windows-fix");
    expect(extractSkillName("windows-fix", "npm")).toBe("windows-fix");
  });
});

describe("createSkillsAdapter - plugin skill merge", () => {
  // A disk-discovered skill "ce-work" lives at <baseDir>/ce-work/SKILL.md →
  // discoverSkills derives the catalog name "ce-work/SKILL.md" (bare "ce-work").
  const diskSkillResource = {
    path: "/tmp/skills-root/ce-work/SKILL.md",
    enabled: true,
    metadata: {
      source: "owner/repo",
      scope: "project" as const,
      origin: "top-level" as const,
      baseDir: "/tmp/skills-root",
    },
  };

  it("adds plugin-contributed skills to the discovered list with bare names", async () => {
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: () => "/tmp/does-not-exist-settings.json",
      getPluginSkills: () => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-plan", enabled: true } },
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-work" } },
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-debug", enabled: false } },
      ],
    });

    const skills = await adapter.discoverSkills("/tmp/project");
    const byName = new Map(skills.map((s) => [s.name, s]));

    expect(byName.has("ce-plan")).toBe(true);
    expect(byName.has("ce-work")).toBe(true);
    expect(byName.get("ce-plan")!.metadata.source).toBe("plugin:fusion-plugin-compound-engineering");
    // enabled defaults to true unless the contribution sets enabled === false.
    expect(byName.get("ce-work")!.enabled).toBe(true);
    expect(byName.get("ce-debug")!.enabled).toBe(false);
    // Ids are stable + parseable, and distinct from any disk skill id.
    expect(byName.get("ce-plan")!.id).toContain("::");
  });

  it("passes the requesting project root into async plugin-skill discovery", async () => {
    const daemonRoot = "/tmp/daemon-root";
    const projectRoot = "/tmp/managed-project";
    const getPluginSkills = vi.fn(async (rootDir: string) => {
      if (rootDir === projectRoot) {
        return [{ pluginId: "project-plugin", skill: { name: "project-only-skill" } }];
      }
      if (rootDir === daemonRoot) {
        return [{ pluginId: "daemon-plugin", skill: { name: "daemon-only-skill" } }];
      }
      return [];
    });
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: () => "/tmp/does-not-exist-settings.json",
      getPluginSkills,
    });

    const projectSkills = await adapter.discoverSkills(projectRoot);
    const daemonSkills = await adapter.discoverSkills(daemonRoot);

    expect(getPluginSkills).toHaveBeenCalledWith(projectRoot);
    expect(getPluginSkills).toHaveBeenCalledWith(daemonRoot);
    expect(projectSkills.map((skill) => skill.metadata.source)).toEqual(["plugin:project-plugin"]);
    expect(projectSkills.map((skill) => skill.name)).toEqual(["project-only-skill"]);
    expect(daemonSkills.map((skill) => skill.metadata.source)).toEqual(["plugin:daemon-plugin"]);
    expect(daemonSkills.map((skill) => skill.name)).toEqual(["daemon-only-skill"]);
  });

  it("dedups a plugin skill that is already discovered on disk (by bare name)", async () => {
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [diskSkillResource] }) },
      getSettingsPath: () => "/tmp/does-not-exist-settings.json",
      getPluginSkills: () => [
        { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-work" } },
      ],
    });

    const skills = await adapter.discoverSkills("/tmp/project");
    const ceWorkEntries = skills.filter((s) => bareSkillName(s.name) === "ce-work");

    // Only the disk entry survives — the plugin duplicate is not appended.
    expect(ceWorkEntries).toHaveLength(1);
    expect(ceWorkEntries[0]!.metadata.source).toBe("owner/repo");
  });

  it("is a no-op when no getPluginSkills callback is supplied", async () => {
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: () => "/tmp/does-not-exist-settings.json",
    });

    const skills = await adapter.discoverSkills("/tmp/project");
    expect(skills).toEqual([]);
  });

  it("lets a project-settings toggle override a plugin skill's default enabled", async () => {
    const dir = join(tmpdir(), `skills-adapter-plugin-toggle-${process.pid}-${Date.now()}`);
    const settingsPath = join(dir, "settings.json");
    await mkdir(dir, { recursive: true });
    // ce-plan defaults to enabled, but a "-" entry under its plugin package
    // source must disable it; without the settings lookup the toggle is lost.
    const relativePath = "skills/ce-plan/SKILL.md";
    const settings = {
      packages: [{ source: "plugin:fusion-plugin-compound-engineering", skills: [`-${relativePath}`] }],
    };
    await writeFile(settingsPath, JSON.stringify(settings));

    try {
      const adapter = createSkillsAdapter({
        packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
        getSettingsPath: () => settingsPath,
        getPluginSkills: () => [
          { pluginId: "fusion-plugin-compound-engineering", skill: { name: "ce-plan", enabled: true } },
        ],
      });

      const skills = await adapter.discoverSkills(dir);
      const cePlan = skills.find((s) => s.name === "ce-plan");
      expect(cePlan).toBeDefined();
      expect(cePlan!.enabled).toBe(false);
      expect(cePlan!.enabled).toBe(resolvePluginSkillEnabled(
        settings,
        "fusion-plugin-compound-engineering",
        "ce-plan",
        true,
      ));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps plugin discovery enablement in parity with the shared session resolver", async () => {
    const dir = join(tmpdir(), `skills-adapter-plugin-parity-${process.pid}-${Date.now()}`);
    const settingsPath = join(dir, "settings.json");
    await mkdir(dir, { recursive: true });
    const settings = {
      packages: [
        { source: "plugin:fusion-plugin-compound-engineering", skills: ["+skills/opt-in/SKILL.md"] },
        { source: "plugin:fusion-plugin-compound-engineering", skills: ["-skills/opt-out/SKILL.md"] },
      ],
    };
    await writeFile(settingsPath, JSON.stringify(settings));

    try {
      const adapter = createSkillsAdapter({
        packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
        getSettingsPath: () => settingsPath,
        getPluginSkills: () => [
          { pluginId: "fusion-plugin-compound-engineering", skill: { name: "opt-in", enabled: false } },
          { pluginId: "fusion-plugin-compound-engineering", skill: { name: "opt-out", enabled: true } },
          { pluginId: "fusion-plugin-compound-engineering", skill: { name: "default-on" } },
        ],
      });

      const byName = new Map((await adapter.discoverSkills(dir)).map((skill) => [skill.name, skill.enabled]));
      expect(byName).toEqual(new Map([
        ["opt-in", true],
        ["opt-out", false],
        ["default-on", true],
      ]));
      for (const [name, enabled] of byName) {
        const staticEnabled = name === "opt-in" ? false : true;
        expect(enabled).toBe(resolvePluginSkillEnabled(
          settings,
          "fusion-plugin-compound-engineering",
          name,
          staticEnabled,
        ));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createSkillsAdapter - readSkillContent for plugin skills", () => {
  it("returns synthesized content (not a blank panel) for plugin-contributed skills", async () => {
    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: () => "/tmp/does-not-exist-settings.json",
      getPluginSkills: () => [
        {
          pluginId: "fusion-plugin-compound-engineering",
          skill: { name: "ce-plan", description: "Create structured plans." },
        },
      ],
    });

    const skills = await adapter.discoverSkills("/tmp/project");
    const cePlan = skills.find((s) => s.name === "ce-plan")!;

    const content = await adapter.readSkillContent("/tmp/project", cePlan.id);
    expect(content.name).toBe("ce-plan");
    expect(content.skillMd).toContain("ce-plan");
    expect(content.skillMd).toContain("Create structured plans.");
    expect(content.skillMd).toContain("fusion-plugin-compound-engineering");
    expect(content.skillMd).not.toBe("");
    expect(content.files).toEqual([]);
  });
});

describe("bareSkillName", () => {
  it("reduces every skill-name form to the same bare token", () => {
    expect(bareSkillName("compound-engineering:ce-work")).toBe("ce-work");
    expect(bareSkillName("ce-work/SKILL.md")).toBe("ce-work");
    expect(bareSkillName("compound-engineering::skills/ce-work/SKILL.md")).toBe("ce-work");
    expect(bareSkillName("ce-work")).toBe("ce-work");
    expect(bareSkillName("")).toBe("");
  });
});
