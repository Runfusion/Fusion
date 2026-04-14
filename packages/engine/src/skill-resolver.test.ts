/**
 * Unit tests for skill resolver.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSessionSkills,
  createSkillsOverrideFromSelection,
  type SkillSelectionResult,
} from "./skill-resolver.js";

// ── Mock Setup ───────────────────────────────────────────────────────────────

// In-memory file system for tests - using a proxy to intercept fs calls
const mockFiles = new Map<string, string>();
let mockDirCounter = 0;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: unknown) => mockFiles.has(String(path)),
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
    mockFiles.set(`${dir}/.fusion/settings.json`, JSON.stringify(settings));
  }
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("resolveSessionSkills", () => {
  beforeEach(() => {
    mockFiles.clear();
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

  describe("reads from .fusion/settings.json primary and .pi/settings.json fallback", () => {
    it("prefers .fusion/settings.json over .pi/settings.json", () => {
      const dir = createMockProjectDir(null);

      // Create .pi/settings.json (legacy)
      mockFiles.set(`${dir}/.pi/settings.json`, JSON.stringify({
        skills: ["+skills/legacy/SKILL.md"],
      }));

      // Create .fusion/settings.json (newer, should win)
      mockFiles.set(`${dir}/.fusion/settings.json`, JSON.stringify({
        skills: ["+skills/fusion/SKILL.md"],
      }));

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.allowedSkillPaths.has("skills/fusion/SKILL.md")).toBe(true);
      expect(result.allowedSkillPaths.has("skills/legacy/SKILL.md")).toBe(false);
    });

    it("falls back to .pi/settings.json when .fusion/settings.json doesn't exist", () => {
      const dir = createMockProjectDir(null);

      // Create only .pi/settings.json (legacy)
      mockFiles.set(`${dir}/.pi/settings.json`, JSON.stringify({
        skills: ["+skills/legacy/SKILL.md"],
      }));

      const result = resolveSessionSkills({
        projectRootDir: dir,
      });

      expect(result.allowedSkillPaths.has("skills/legacy/SKILL.md")).toBe(true);
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
  });
});

describe("createSkillsOverrideFromSelection", () => {
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

    it("appends warning diagnostic for allowed paths not matching any skill", () => {
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
      expect(result.diagnostics[0].type).toBe("warning");
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
      expect(result.diagnostics[0].type).toBe("warning");
      expect(result.diagnostics[0].message).toContain("CustomSkill");
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

    it("logs diagnostics via console.error", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const selection: SkillSelectionResult = {
        allowedSkillPaths: new Set(["/path/nonexistent"]),
        excludedSkillPaths: new Set<string>(),
        diagnostics: [],
        filterActive: true,
      };

      const override = createSkillsOverrideFromSelection(selection, {
        sessionPurpose: "executor",
      });

      const base = {
        skills: [],
        diagnostics: [],
      };

      override(base);

      expect(consoleErrorSpy).toHaveBeenCalled();
      const lastCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("[pi] [skills]");
      expect(lastCall).toContain("nonexistent");

      consoleErrorSpy.mockRestore();
    });

    it("includes sessionPurpose in log messages when provided", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

      const lastCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("[reviewer]");
      expect(lastCall).toContain("missing-skill");

      consoleErrorSpy.mockRestore();
    });

    it("produces warning diagnostic for disabled skills (exists but excluded by patterns)", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
      expect(consoleErrorSpy).toHaveBeenCalled();
      const lastCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("disabled");

      consoleErrorSpy.mockRestore();
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
      // 1. Warning for missing-skill (allowed path not found in discovered skills)
      // 2. Warning for disabled-skill (exists but was excluded by patterns)
      // Both are "warning" type since ResourceDiagnostic only supports warning|error|collision
      // The distinction is made via message content
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
  });
});
