/**
 * Unit tests for skill resolver.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPiLog } = vi.hoisted(() => ({
  mockPiLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logger.js", () => ({
  piLog: mockPiLog,
}));

import {
  resolveSessionSkills,
  resolveProjectRoot,
  createSkillsOverrideFromSelection,
  type SkillSelectionResult,
} from "../skill-resolver.js";

// ── Mock Setup ───────────────────────────────────────────────────────────────

// In-memory file system for tests - using a proxy to intercept fs calls
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
let mockDirCounter = 0;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: unknown) => mockFiles.has(String(path)) || mockDirs.has(String(path)),
    readFileSync: (path: unknown) => mockFiles.get(String(path)) ?? "{}",
    mkdtempSync: () => `/tmp/skill-resolver-mock-${++mockDirCounter}`,
    writeFileSync: (path: unknown, content: unknown) => mockFiles.set(String(path), String(content)),
    rmSync: (path: unknown) => {
      const pathStr = String(path);
      for (const key of mockFiles.keys()) {
        if (key.startsWith(pathStr)) mockFiles.delete(key);
      }
    },
  };
});

// ── Test Helpers ─────────────────────────────────────────────────────────────

function createMockProjectDir(settings: Record<string, unknown> | null): string {
  const dir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
  if (settings !== null) {
    mockDirs.add(`${dir}/.fusion`);
    mockFiles.set(`${dir}/.fusion/settings.json`, JSON.stringify(settings));
  }
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("resolveProjectRoot", () => {
  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    mockDirCounter = 0;
  });

  it("returns cwd directly when cwd contains .fusion", () => {
    const dir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
    mockDirs.add(`${dir}/.fusion`);

    expect(resolveProjectRoot(dir)).toBe(dir);
  });

  it("prefers parent repo root for worktree paths when both parent and worktree have .fusion", () => {
    const projectDir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
    const worktreeDir = `${projectDir}/.worktrees/swift-falcon`;
    mockDirs.add(`${projectDir}/.fusion`);
    mockDirs.add(`${worktreeDir}/.fusion`);

    expect(resolveProjectRoot(`${worktreeDir}/sub`)).toBe(projectDir);
  });

  it("falls back to legacy walk when parent repo .fusion is missing", () => {
    const projectDir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
    const worktreeDir = `${projectDir}/.worktrees/swift-falcon`;
    mockDirs.add(`${worktreeDir}/.fusion`);

    expect(resolveProjectRoot(`${worktreeDir}/sub`)).toBe(worktreeDir);
  });

  it("walks up from deeply nested path", () => {
    const projectDir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
    const nestedDir = `${projectDir}/.worktrees/task-branch/src/components`;
    mockDirs.add(`${projectDir}/.fusion`);

    expect(resolveProjectRoot(nestedDir)).toBe(projectDir);
  });

  it("returns cwd when no .fusion directory found anywhere", () => {
    const dir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;

    // No .fusion set up anywhere
    expect(resolveProjectRoot(dir)).toBe(dir);
  });

  it("returns cwd when .fusion is in a sibling directory (not ancestor)", () => {
    const parentDir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
    const dir = `${parentDir}/my-project`;
    const siblingDir = `${parentDir}/other-project`;
    mockDirs.add(`${siblingDir}/.fusion`);

    // Walking up from dir should not find sibling's .fusion
    expect(resolveProjectRoot(dir)).toBe(dir);
  });
});

describe("resolveSessionSkills", () => {
  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    mockDirCounter = 0;
  });

  describe("returns filterActive: false when no patterns and no requested names", () => {
    it("returns filterActive: false when no settings file exists", () => {
      const result = resolveSessionSkills({
        projectRootDir: "/nonexistent",
      });

      expect(result.filterActive).toBe(false);
      expect(result.allowedSkillPaths.size).toBe(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("returns filterActive: false when settings file is empty", () => {
      const dir = createMockProjectDir({});
      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(false);
      expect(result.allowedSkillPaths.size).toBe(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("returns filterActive: false when settings has no skill configuration", () => {
      const dir = createMockProjectDir({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      });
      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(false);
      expect(result.allowedSkillPaths.size).toBe(0);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe("returns filterActive: true with + patterns", () => {
    it("adds skill paths to allowed set with + prefix", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/paperclip/SKILL.md", "+skills/lint/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.size).toBe(2);
      expect(result.allowedSkillPaths.has("skills/paperclip/SKILL.md")).toBe(true);
      expect(result.allowedSkillPaths.has("skills/lint/SKILL.md")).toBe(true);
    });

    it("adds skill paths to allowed set without prefix (implicit +)", () => {
      const dir = createMockProjectDir({
        skills: ["skills/paperclip/SKILL.md", "skills/lint/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.size).toBe(2);
    });
  });

  describe("excludes - pattern skills from allowed set", () => {
    it("removes skill from allowed set with - prefix", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/foo/SKILL.md", "+skills/bar/SKILL.md", "-skills/foo/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.size).toBe(1);
      expect(result.allowedSkillPaths.has("skills/foo/SKILL.md")).toBe(false);
      expect(result.allowedSkillPaths.has("skills/bar/SKILL.md")).toBe(true);
      // Verify excludedSkillPaths is also populated
      expect(result.excludedSkillPaths.size).toBe(1);
      expect(result.excludedSkillPaths.has("skills/foo/SKILL.md")).toBe(true);
    });

    it("exclusion pattern removes previously added entry", () => {
      const dir = createMockProjectDir({
        skills: ["skills/foo/SKILL.md", "-skills/foo/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.allowedSkillPaths.size).toBe(0);
      expect(result.excludedSkillPaths.size).toBe(1);
      expect(result.excludedSkillPaths.has("skills/foo/SKILL.md")).toBe(true);
    });

    it("tracks excluded paths from multiple exclusion patterns", () => {
      const dir = createMockProjectDir({
        skills: ["-skills/foo/SKILL.md", "-skills/bar/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.size).toBe(0);
      expect(result.excludedSkillPaths.size).toBe(2);
      expect(result.excludedSkillPaths.has("skills/foo/SKILL.md")).toBe(true);
      expect(result.excludedSkillPaths.has("skills/bar/SKILL.md")).toBe(true);
    });
  });

  describe("handles mixed + / - patterns correctly", () => {
    it("last entry wins for duplicate paths", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/foo/SKILL.md", "-skills/foo/SKILL.md", "+skills/foo/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      // Last + wins
      expect(result.allowedSkillPaths.has("skills/foo/SKILL.md")).toBe(true);
      expect(result.excludedSkillPaths.has("skills/foo/SKILL.md")).toBe(false);
    });

    it("last entry wins (exclusion after inclusion)", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/foo/SKILL.md", "+skills/foo/SKILL.md", "-skills/foo/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      // Last - wins
      expect(result.allowedSkillPaths.has("skills/foo/SKILL.md")).toBe(false);
      expect(result.excludedSkillPaths.has("skills/foo/SKILL.md")).toBe(true);
    });
  });

  describe("handles requestedSkillNames", () => {
    it("with no patterns, only requested names marks filterActive: true", () => {
      const result = resolveSessionSkills({
        projectRootDir: "/nonexistent",
        requestedSkillNames: ["paperclip", "lint"],
      });

      expect(result.filterActive).toBe(true);
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics.some(d => d.skillName === "paperclip")).toBe(true);
      expect(result.diagnostics.some(d => d.skillName === "lint")).toBe(true);
    });

    it("requestedSkillNames act as info diagnostics when no patterns exist", () => {
      const result = resolveSessionSkills({
        projectRootDir: "/nonexistent",
        requestedSkillNames: ["custom-skill"],
      });

      expect(result.filterActive).toBe(true);
      const nameDiags = result.diagnostics.filter(d => d.skillName === "custom-skill");
      expect(nameDiags).toHaveLength(1);
      expect(nameDiags[0].type).toBe("info");
    });
  });

  describe("package-scoped skill patterns", () => {
    it("extracts skills from package objects with skills array", () => {
      const dir = createMockProjectDir({
        packages: [
          {
            source: "@myorg/ai-kit",
            skills: ["+skills/custom/SKILL.md"],
          },
        ],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.has("skills/custom/SKILL.md")).toBe(true);
    });

    it("handles mixed top-level and package-scoped patterns", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/shared/SKILL.md"],
        packages: [
          {
            source: "@myorg/ai-kit",
            skills: ["+skills/package-skill/SKILL.md"],
          },
        ],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.size).toBe(2);
      expect(result.allowedSkillPaths.has("skills/shared/SKILL.md")).toBe(true);
      expect(result.allowedSkillPaths.has("skills/package-skill/SKILL.md")).toBe(true);
    });

    it("handles string package entries without crashing", () => {
      const dir = createMockProjectDir({
        packages: ["@myorg/ai-kit"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      // Should not crash, patterns array is undefined for string entries
      expect(result.filterActive).toBe(false);
      expect(result.allowedSkillPaths.size).toBe(0);
    });

    it("handles package objects without skills array", () => {
      const dir = createMockProjectDir({
        packages: [
          {
            source: "@myorg/ai-kit",
            extensions: ["dist/index.js"],
          },
        ],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      // No skill patterns exist (package has extensions, not skills)
      expect(result.filterActive).toBe(false);
      expect(result.allowedSkillPaths.size).toBe(0);
    });
  });

  describe("reads from .fusion/settings.json only", () => {
    it("reads from .fusion/settings.json", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/fusion/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.allowedSkillPaths.has("skills/fusion/SKILL.md")).toBe(true);
    });

    it("resolves project root from worktree path", () => {
      const projectDir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
      const worktreeDir = `${projectDir}/.worktrees/branch-name`;

      // Set up project root with .fusion directory and settings
      mockDirs.add(`${projectDir}/.fusion`);
      mockFiles.set(`${projectDir}/.fusion/settings.json`, JSON.stringify({
        skills: ["+skills/fusion/SKILL.md"],
      }));

      // Call with the worktree path (not the project root)
      const result = resolveSessionSkills({
        projectRootDir: worktreeDir,
      });

      // Should have resolved to the project root and read settings correctly
      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.has("skills/fusion/SKILL.md")).toBe(true);
    });

    it("resolves project root from deeply nested worktree subdirectory", () => {
      const projectDir = `/tmp/skill-resolver-mock-${++mockDirCounter}`;
      const worktreeSubdir = `${projectDir}/.worktrees/task-branch/src/components`;

      mockDirs.add(`${projectDir}/.fusion`);
      mockFiles.set(`${projectDir}/.fusion/settings.json`, JSON.stringify({
        skills: ["+skills/review/SKILL.md", "+skills/lint/SKILL.md"],
      }));

      const result = resolveSessionSkills({
        projectRootDir: worktreeSubdir,
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.size).toBe(2);
      expect(result.allowedSkillPaths.has("skills/review/SKILL.md")).toBe(true);
      expect(result.allowedSkillPaths.has("skills/lint/SKILL.md")).toBe(true);
    });
  });

  describe("handles missing/empty settings files gracefully", () => {
    it("handles invalid JSON gracefully", () => {
      const dir = createMockProjectDir(null);

      // Set invalid JSON
      mockFiles.set(`${dir}/.fusion/settings.json`, "not valid json {{{");

      // Should not throw
      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(false);
    });

    it("handles malformed settings object gracefully", () => {
      const dir = createMockProjectDir(null);

      mockFiles.set(`${dir}/.fusion/settings.json`, JSON.stringify({
        skills: "not an array",
        packages: "also not an array",
      }));

      // Should not throw - malformed data treated as no patterns
      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.filterActive).toBe(false);
      expect(result.allowedSkillPaths.size).toBe(0);
    });
  });

  describe("produces info diagnostics for patterns", () => {
    it("produces info diagnostic for each + pattern", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/foo/SKILL.md", "-skills/bar/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      const infoDiags = result.diagnostics.filter(d => d.type === "info");
      expect(infoDiags).toHaveLength(1); // Only + pattern gets info diag
      expect(infoDiags[0].skillPath).toBe("skills/foo/SKILL.md");
    });

    it("with requestedSkillNames intersects with allowed patterns and produces correct diagnostics", () => {
      const dir = createMockProjectDir({
        skills: ["+skills/review/SKILL.md", "+skills/lint/SKILL.md"],
      });

      const result = resolveSessionSkills({
        projectRootDir: dir,
        requestedSkillNames: ["review", "missing-skill"],
      });

      expect(result.filterActive).toBe(true);
      expect(result.allowedSkillPaths.has("skills/review/SKILL.md")).toBe(true);
      expect(result.allowedSkillPaths.has("skills/lint/SKILL.md")).toBe(true);

      // Check for info diagnostics
      const infoDiags = result.diagnostics.filter(d => d.type === "info");
      // Should have diagnostics for: review (requested), missing-skill (requested), +skills/review (pattern), +skills/lint (pattern)
      expect(infoDiags.some(d => d.skillName === "review")).toBe(true);
      expect(infoDiags.some(d => d.skillName === "missing-skill")).toBe(true);
      expect(infoDiags.some(d => d.skillPath === "skills/review/SKILL.md")).toBe(true);
      expect(infoDiags.some(d => d.skillPath === "skills/lint/SKILL.md")).toBe(true);
    });
  });
});

describe("createSkillsOverrideFromSelection", () => {
  beforeEach(() => {
    mockPiLog.log.mockClear();
    mockPiLog.warn.mockClear();
    mockPiLog.error.mockClear();
  });

  describe("with filterActive: false", () => {
    it("returns base unchanged", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(),
        excludedSkillPaths: new Set(),
        diagnostics: [],
        filterActive: false,
      };

      const override = createSkillsOverrideFromSelection(selection);
      const base = {
        skills: [
          { name: "foo", filePath: "/path/foo", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "bar", filePath: "/path/bar", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      expect(result.skills).toHaveLength(2);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe("with filterActive: true", () => {
    it("filters skills by allowedSkillPaths", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/foo"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection);
      const base = {
        skills: [
          { name: "foo", filePath: "/path/foo", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "bar", filePath: "/path/bar", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("foo");
    });

    it("appends info diagnostic for allowed paths not matching any skill", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/nonexistent"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection);
      const base = {
        skills: [
          { name: "foo", filePath: "/path/foo", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      expect(result.skills).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe("info");
      expect(result.diagnostics[0].message).toContain("not found in discovered skills");
    });

    it("checks requested names against discovered skills (case-insensitive)", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["PAPERCLIP", "CustomSkill"],
        sessionPurpose: "test",
      });

      const base = {
        skills: [
          { name: "paperclip", filePath: "/path/paperclip", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "lint", filePath: "/path/lint", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      expect(result.diagnostics).toHaveLength(1); // Only CustomSkill not found
      expect(result.diagnostics[0].type).toBe("info");
      expect(result.diagnostics[0].message).toContain("CustomSkill");
    });

    it.each([
      ["single token", "pr"],
      ["slash form", "review/pr"],
      ["skill file path form", "review/pr/SKILL.md"],
      ["catalog id form", "source::skills/review/pr/SKILL.md"],
    ])("loads requested skills by %s", (_label, requestedName) => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: [requestedName],
        sessionPurpose: "test",
      });

      const result = override({
        skills: [
          { name: "pr", filePath: "/skills/review/pr/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "gamma", filePath: "/skills/gamma/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      });

      expect(result.skills.map((skill) => skill.name)).toEqual(["pr"]);
      expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("not found"))).toBe(false);
    });

    it("emits the requested-skill-not-found diagnostic for genuinely absent requested names", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["review/absent"],
        sessionPurpose: "chat",
      });

      const result = override({
        skills: [
          { name: "pr", filePath: "/skills/review/pr/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      });

      expect(result.skills).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe("info");
      expect(result.diagnostics[0].message).toContain("Requested skill 'review/absent' not found");
    });

    it("does not force-load requested skills disabled by execution settings", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(),
        excludedSkillPaths: new Set<string>(["/skills/review/pr/SKILL.md"]),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["review/pr"],
        sessionPurpose: "chat",
      });

      const result = override({
        skills: [
          { name: "pr", filePath: "/skills/review/pr/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      });

      expect(result.skills).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe("warning");
      expect(result.diagnostics[0].message).toContain("disabled by project execution settings");
      expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("not found"))).toBe(false);
    });

    it("leaves no-requested-names inactive filtering behavior unchanged", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: false,
      };
      const base = {
        skills: [
          { name: "pr", filePath: "/skills/review/pr/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "gamma", filePath: "/skills/gamma/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      expect(createSkillsOverrideFromSelection(selection)(base)).toBe(base);
    });

    it("preserves base diagnostics alongside new diagnostics", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/foo"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection);
      const base = {
        skills: [
          { name: "foo", filePath: "/path/foo", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [
          { type: "warning" as const, message: "base warning" },
        ],
      };

      const result = override(base);

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].message).toBe("base warning");
    });

    it("logs requested-skill diagnostics via structured logger", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set<string>(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["nonexistent"],
        sessionPurpose: "executor",
      });

      const base = {
        skills: [],
        diagnostics: [],
      };

      override(base);

      expect(mockPiLog.log).toHaveBeenCalled();
      const lastCall = mockPiLog.log.mock.calls[mockPiLog.log.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("[skills]");
      expect(lastCall).toContain("nonexistent");
    });

    it("includes sessionPurpose in structured logger messages when provided", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/foo"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["missing-skill"],
        sessionPurpose: "reviewer",
      });

      const base = {
        skills: [
          { name: "foo", filePath: "/path/foo", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      override(base);

      const lastCall = mockPiLog.log.mock.calls[mockPiLog.log.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("[reviewer]");
      expect(lastCall).toContain("missing-skill");
    });

    it("produces warning diagnostic for disabled skills (exists but excluded by patterns)", () => {
      // Simulate a skill that exists but was disabled by project exclusion pattern
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set<string>(),
        excludedSkillPaths: new Set(["/path/disabled-skill"]),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        sessionPurpose: "executor",
      });

      // Skill exists in discovered skills but was excluded
      const base = {
        skills: [
          { name: "disabled-skill", filePath: "/path/disabled-skill", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      // Skill should be filtered out (excluded)
      expect(result.skills).toHaveLength(0);

      // Should produce warning diagnostic for disabled skill (ResourceDiagnostic only supports warning|error|collision)
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].type).toBe("warning");
      expect(result.diagnostics[0].message).toContain("disabled");
      expect(result.diagnostics[0].message).toContain("disabled-skill");

      // Verify logging
      expect(mockPiLog.warn).toHaveBeenCalled();
      const lastCall = mockPiLog.warn.mock.calls[mockPiLog.warn.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("disabled");
    });

    it("distinguishes missing skills (not found) from disabled skills (excluded) via message content", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/allowed-skill", "/path/missing-skill"]),
        excludedSkillPaths: new Set(["/path/disabled-skill"]),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection);

      // All three skills exist in discovered skills
      const base = {
        skills: [
          { name: "allowed-skill", filePath: "/path/allowed-skill", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "disabled-skill", filePath: "/path/disabled-skill", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "other", filePath: "/path/other", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      // Only "allowed-skill" should pass through (in allowed paths AND not in excluded paths)
      // "disabled-skill" is excluded by patterns
      // "other" is not in allowed paths
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("allowed-skill");

      // Should have 2 diagnostics:
      // 1. Info for missing-skill (allowed path not found in discovered skills)
      // 2. Warning for disabled-skill (exists but was excluded by patterns)
      // The distinction is made via type and message content
      expect(result.diagnostics).toHaveLength(2);

      const missingDiag = result.diagnostics.find(d => d.message.includes("missing-skill"));
      expect(missingDiag).toBeDefined();
      expect(missingDiag!.message).toContain("missing-skill");
      expect(missingDiag!.message).toContain("not found");

      const disabledDiag = result.diagnostics.find(d => d.message.includes("disabled-skill"));
      expect(disabledDiag).toBeDefined();
      expect(disabledDiag!.message).toContain("disabled-skill");
      expect(disabledDiag!.message).toContain("disabled");
    });

    it("returns skills in deterministic order (same input = same output order)", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/c", "/path/b", "/path/a"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection);

      // Input order: c, a, b
      const base1 = {
        skills: [
          { name: "c", filePath: "/path/c", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "a", filePath: "/path/a", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "b", filePath: "/path/b", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      // Same input order: c, a, b (should produce same output)
      const base2 = {
        skills: [
          { name: "c", filePath: "/path/c", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "a", filePath: "/path/a", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "b", filePath: "/path/b", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result1 = override(base1);
      const result2 = override(base2);

      // Both results should have the same skills in the same order
      expect(result1.skills.map(s => s.name)).toEqual(result2.skills.map(s => s.name));
      // Order is preserved from input order (deterministic = consistent)
      expect(result1.skills.map(s => s.name)).toEqual(["c", "a", "b"]);
    });

    it("filters discovered Skill[] by requested names and logs info diagnostics for missing skills", () => {
      // Create selection with empty allowed paths (only requested names filtering)
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set<string>(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["found-skill", "missing-skill"],
        sessionPurpose: "executor",
      });

      // Only one skill matches the requested names
      const base = {
        skills: [
          { name: "found-skill", filePath: "/path/found", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      // Should only return the found skill
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("found-skill");

      // Should produce info diagnostic for missing-skill
      const missingInfo = result.diagnostics.find(d =>
        d.type === "info" && d.message.includes("missing-skill") && d.message.includes("not found in discovered skills")
      );
      expect(missingInfo).toBeDefined();

      // Verify structured logger info output
      expect(mockPiLog.log).toHaveBeenCalled();
      const loggedMessages = mockPiLog.log.mock.calls.map(c => c[0] as string);
      const hasExecutorPrefix = loggedMessages.some(m => m.includes("[executor]") && m.includes("missing-skill"));
      expect(hasExecutorPrefix).toBe(true);
    });

    it("does not emit missing-skill info diagnostics for built-in fusion fallback requests", () => {
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set<string>(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["fusion"],
        sessionPurpose: "reviewer",
      });

      const result = override({
        skills: [],
        diagnostics: [],
      });

      expect(result.skills).toHaveLength(0);
      expect(
        result.diagnostics.find((d) =>
          d.type === "info"
          && d.message.includes("Requested skill 'fusion' not found in discovered skills"),
        ),
      ).toBeUndefined();
      expect(
        mockPiLog.log.mock.calls.some((c) => (c[0] as string).includes("Requested skill 'fusion' not found")),
      ).toBe(false);
    });

    it("keeps optional missing configured patterns diagnostic-only without the user-reported info log", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["ce-optimize/SKILL.md", "lint/SKILL.md"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        sessionPurpose: "executor",
      });

      const result = override({
        skills: [
          { name: "lint", filePath: "/platform-neutral/skills/lint/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "paperclip", filePath: "/platform-neutral/skills/paperclip/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      });
      const userReportedLine = "Configured skill pattern 'ce-optimize/SKILL.md' not found in discovered skills [executor]";

      expect(result.skills.map((skill) => skill.name)).toEqual(["lint"]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        type: "info",
        message: userReportedLine,
        path: "ce-optimize/SKILL.md",
      }));
      expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("lint/SKILL.md") && diagnostic.message.includes("not found"))).toBe(false);

      const loggedMessages = [
        ...mockPiLog.log.mock.calls,
        ...mockPiLog.warn.mock.calls,
        ...mockPiLog.error.mock.calls,
      ].map((call) => String(call[0]));
      expect(loggedMessages.some((message) => message.includes(userReportedLine))).toBe(false);
      expect(mockPiLog.warn).not.toHaveBeenCalled();
      expect(mockPiLog.error).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it("does not call console.error, console.warn, or console.log for diagnostics", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set<string>(),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        requestedSkillNames: ["missing"],
        sessionPurpose: "executor",
      });

      override({ skills: [], diagnostics: [] });

      expect(mockPiLog.log).toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });
  });

  describe("end-to-end flow with project settings + agent metadata + discovered skills", () => {
    beforeEach(() => {
      mockFiles.clear();
      mockDirCounter = 0;
    });

    it("full end-to-end flow: settings patterns + agent skills produce matching override", () => {
      // Create mock project dir with settings that include review but exclude lint
      const dir = createMockProjectDir({
        skills: ["+skills/review/SKILL.md"],
      });

      // Step 1: Resolve session skills from settings
      const resolvedSkills = resolveSessionSkills({
        projectRootDir: dir,
        requestedSkillNames: ["review"],
      });

      expect(resolvedSkills.filterActive).toBe(true);
      expect(resolvedSkills.allowedSkillPaths.has("skills/review/SKILL.md")).toBe(true);

      // Step 2: Create override from selection
      const override = createSkillsOverrideFromSelection(resolvedSkills, {
        sessionPurpose: "executor",
      });

      // Step 3: Apply override to discovered skills (both review and lint exist)
      const base = {
        skills: [
          { name: "review", filePath: "skills/review/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "lint", filePath: "skills/lint/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      // Only review should pass through (lint is not in allowed paths)
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("review");

      // No missing-skill info diagnostics since review exists and matches the pattern
      const missingInfoDiagnostics = result.diagnostics.filter(d =>
        d.type === "info" && d.message.includes("not found")
      );
      expect(missingInfoDiagnostics).toHaveLength(0);
    });

    it("matches Fusion two-segment patterns against pi-coding-agent bare skill names", () => {
      // Fusion's toggleExecutionSkill saves patterns like "+web-research/SKILL.md"
      // and normalizeAgentSkills extracts "web-research/SKILL.md" from full IDs.
      // But pi-coding-agent sets Skill.name to just the directory name: "web-research".
      // This test verifies the cross-format matching works.
      const dir = createMockProjectDir({
        skills: ["+web-research/SKILL.md"],
      });

      const resolvedSkills = resolveSessionSkills({
        projectRootDir: dir,
        // Simulates what normalizeAgentSkills produces from "auto::skills/web-research/SKILL.md"
        requestedSkillNames: ["web-research/SKILL.md"],
        sessionPurpose: "triage",
      });

      const override = createSkillsOverrideFromSelection(resolvedSkills, {
        requestedSkillNames: resolvedSkills.allowedSkillPaths.size > 0
          ? ["web-research/SKILL.md"]
          : undefined,
        sessionPurpose: "triage",
      });

      // pi-coding-agent discovers skills with bare directory names
      const base = {
        skills: [
          { name: "web-research", filePath: "/home/user/.pi/agent/skills/web-research/SKILL.md", description: "Web search", baseDir: "/home/user/.pi/agent/skills/web-research", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "paperclip", filePath: "/home/user/.pi/agent/skills/paperclip/SKILL.md", description: "Paperclip", baseDir: "/home/user/.pi/agent/skills/paperclip", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      // web-research should match despite the naming mismatch
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("web-research");

      // No spurious "not found" info diagnostics
      const notFoundInfoDiagnostics = result.diagnostics.filter(d =>
        d.type === "info" && d.message.includes("not found")
      );
      expect(notFoundInfoDiagnostics).toHaveLength(0);
    });

    it("exclusion patterns with /SKILL.md suffix correctly exclude pi-discovered skills", () => {
      const dir = createMockProjectDir({
        skills: ["+web-research/SKILL.md", "-paperclip/SKILL.md"],
      });

      const resolvedSkills = resolveSessionSkills({
        projectRootDir: dir,
      });

      const override = createSkillsOverrideFromSelection(resolvedSkills, {
        sessionPurpose: "executor",
      });

      const base = {
        skills: [
          { name: "web-research", filePath: "/home/user/.pi/agent/skills/web-research/SKILL.md", description: "Web search", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
          { name: "paperclip", filePath: "/home/user/.pi/agent/skills/paperclip/SKILL.md", description: "Paperclip", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        ],
        diagnostics: [],
      };

      const result = override(base);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe("web-research");

      // Should have a "disabled" diagnostic for paperclip (exists but excluded)
      const disabledWarning = result.diagnostics.find(d =>
        d.message.includes("disabled") && d.message.includes("paperclip")
      );
      expect(disabledWarning).toBeDefined();
    });
  });
});
