import { describe, it, expect } from "vitest";
import { AGENT_PRESETS, getPresetById, getPresetIds } from "../agent-presets";

/**
 * Regression tests for agent preset data integrity.
 *
 * These tests ensure:
 * - All presets have valid, non-empty soul content
 * - All presets have valid, non-empty instructionsText
 * - All presets have required fields populated
 * - No duplicate preset IDs exist
 * - All preset IDs are unique and stable
 */
describe("agent-presets", () => {
  describe("preset data integrity", () => {
    it("exports exactly 20 presets", () => {
      expect(AGENT_PRESETS).toHaveLength(20);
    });

    it("getPresetIds returns exactly 20 IDs", () => {
      const ids = getPresetIds();
      expect(ids).toHaveLength(20);
    });

    it("no duplicate preset IDs", () => {
      const ids = AGENT_PRESETS.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("all presets have unique, stable IDs matching expected set", () => {
      const expectedIds = [
        "ceo", "cto", "cmo", "cfo", "engineer", "backend-engineer",
        "frontend-engineer", "fullstack-engineer", "qa-engineer",
        "devops-engineer", "ci-engineer", "security-engineer",
        "data-engineer", "ml-engineer", "product-manager", "designer",
        "marketing-manager", "technical-writer", "triage", "reviewer",
      ];
      const actualIds = getPresetIds().sort();
      expect(actualIds).toEqual(expectedIds.sort());
    });

    it("getPresetById returns correct preset for all IDs", () => {
      AGENT_PRESETS.forEach((preset) => {
        const found = getPresetById(preset.id);
        expect(found).toBeDefined();
        expect(found?.id).toBe(preset.id);
        expect(found?.name).toBe(preset.name);
      });
    });

    it("getPresetById returns undefined for unknown ID", () => {
      expect(getPresetById("unknown-preset")).toBeUndefined();
    });

    it("every preset has a non-empty id", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.id).toBeTruthy();
        expect(typeof preset.id).toBe("string");
      });
    });

    it("every preset has a non-empty name", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.name).toBeTruthy();
        expect(typeof preset.name).toBe("string");
      });
    });

    it("every preset has a non-empty icon symbol", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.icon).toBeTruthy();
        expect(preset.icon.length).toBeGreaterThan(0);

        // Icons may be emoji or geometric/mathematical symbols.
        // Validate that the first code point is in a non-ASCII symbol range.
        const firstCodePoint = preset.icon.codePointAt(0);
        expect(firstCodePoint).toBeDefined();
        expect(firstCodePoint).toBeGreaterThan(0x2000);
      });
    });

    it("every preset has a non-empty title", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.title).toBeTruthy();
        expect(typeof preset.title).toBe("string");
        expect(preset.title.length).toBeGreaterThan(0);
      });
    });

    it("every preset has a valid role", () => {
      const validRoles = ["triage", "executor", "reviewer", "merger", "scheduler", "engineer", "custom"];
      AGENT_PRESETS.forEach((preset) => {
        expect(validRoles).toContain(preset.role);
      });
    });

    it("every preset has a non-empty description", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.description).toBeTruthy();
        expect(typeof preset.description).toBe("string");
        expect(preset.description!.length).toBeGreaterThan(10);
      });
    });

    it("every preset has non-empty soul content loaded from soul.md", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.soul).toBeTruthy();
        expect(typeof preset.soul).toBe("string");
        expect(preset.soul.length).toBeGreaterThan(100);
        // Soul should contain "I am" (first-person identity)
        expect(preset.soul).toContain("I am");
        // Soul should contain "Principles" or "principles" section
        expect(preset.soul).toMatch(/[Pp]rincipl/);
      });
    });

    it("every preset has non-empty instructionsText", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.instructionsText).toBeTruthy();
        expect(typeof preset.instructionsText).toBe("string");
        expect(preset.instructionsText.length).toBeGreaterThan(50);
      });
    });
  });

  describe("preset soul content", () => {
    it("all souls contain first-person identity statements", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.soul).toContain("I am");
      });
    });

    it("all souls contain at least one operating principle section", () => {
      AGENT_PRESETS.forEach((preset) => {
        // Soul should contain ## heading or bold text for principles
        expect(preset.soul).toMatch(/#{1,2}\s+\w+\s+[Pp]rincipl/);
      });
    });

    it("CEO preset has strategic leadership soul", () => {
      const ceo = getPresetById("ceo");
      expect(ceo?.soul).toContain("strategic");
      expect(ceo?.soul).toContain("business outcomes");
    });

    it("CTO preset has pragmatic technologist soul", () => {
      const cto = getPresetById("cto");
      expect(cto?.soul).toContain("pragmatic technologist");
      expect(cto?.soul).toContain("tradeoff");
    });

    it("Engineer preset has reliability-focused soul", () => {
      const engineer = getPresetById("engineer");
      expect(engineer?.soul).toContain("reliable");
      expect(engineer?.soul).toContain("versatile engineer");
    });

    it("QA Engineer preset has verification-focused soul", () => {
      const qa = getPresetById("qa-engineer");
      expect(qa?.soul).toContain("thorough");
      expect(qa?.soul).toContain("methodical");
      expect(qa?.soul).toContain("verify");
    });

    it("Security Engineer preset has security-first mindset", () => {
      const security = getPresetById("security-engineer");
      expect(security?.soul).toContain("security-first");
      expect(security?.soul).toContain("assumes");
    });

    it("Reviewer preset has rigor and fairness focus", () => {
      const reviewer = getPresetById("reviewer");
      expect(reviewer?.soul).toContain("rigorous");
      expect(reviewer?.soul).toContain("fair");
    });
  });

  describe("preset role assignments", () => {
    it("engineer variants have 'engineer' role", () => {
      const engineerRoles = [
        "engineer", "backend-engineer", "frontend-engineer",
        "fullstack-engineer", "qa-engineer", "devops-engineer",
        "ci-engineer", "security-engineer", "data-engineer", "ml-engineer",
      ];
      engineerRoles.forEach((id) => {
        const preset = getPresetById(id);
        expect(preset?.role).toBe("engineer");
      });
    });

    it("executive presets have 'custom' role", () => {
      const customRoles = ["ceo", "cto", "cmo", "cfo"];
      customRoles.forEach((id) => {
        const preset = getPresetById(id);
        expect(preset?.role).toBe("custom");
      });
    });

    it("triage and reviewer presets have correct roles", () => {
      expect(getPresetById("triage")?.role).toBe("triage");
      expect(getPresetById("reviewer")?.role).toBe("reviewer");
    });

    it("product, design, marketing, and writing presets have 'custom' role", () => {
      const customRoles = [
        "product-manager", "designer", "marketing-manager", "technical-writer",
      ];
      customRoles.forEach((id) => {
        const preset = getPresetById(id);
        expect(preset?.role).toBe("custom");
      });
    });
  });

  describe("preset instructionsText format", () => {
    it("all instructionsText contain action-oriented bullet points", () => {
      AGENT_PRESETS.forEach((preset) => {
        // Instructions should contain action verbs (case-insensitive)
        expect(preset.instructionsText.toLowerCase()).toMatch(/(validate|evaluate|ensure|write|review|add|check|flag|report|design|monitor|test|prioritize|communicate|identify|break|write|validate)/);
      });
    });

    it("instructionsText contain multiple distinct guidance lines", () => {
      AGENT_PRESETS.forEach((preset) => {
        // Should have at least 4 guidance items (separated by newlines)
        const lines = preset.instructionsText.split("\n").filter((l) => l.trim().length > 0);
        expect(lines.length).toBeGreaterThanOrEqual(4);
      });
    });

    it("CEO instructions focus on strategic evaluation", () => {
      const ceo = getPresetById("ceo");
      expect(ceo?.instructionsText).toContain("strategic goals");
      expect(ceo?.instructionsText).toContain("business value");
    });

    it("CTO instructions focus on architecture and patterns", () => {
      const cto = getPresetById("cto");
      expect(cto?.instructionsText).toContain("scalability");
      expect(cto?.instructionsText).toContain("architectural");
    });

    it("Reviewer instructions focus on security and correctness", () => {
      const reviewer = getPresetById("reviewer");
      expect(reviewer?.instructionsText).toContain("security");
      expect(reviewer?.instructionsText).toContain("error handling");
    });
  });

  describe("preset stability", () => {
    it("preset IDs are kebab-case or simple words", () => {
      AGENT_PRESETS.forEach((preset) => {
        expect(preset.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      });
    });

    it("preset names are valid display names", () => {
      AGENT_PRESETS.forEach((preset) => {
        // Names should be non-empty and contain at least one letter
        expect(preset.name).toBeTruthy();
        expect(preset.name.length).toBeGreaterThan(1);
        expect(preset.name).toMatch(/[A-Za-z]/);
      });
    });

    it("professional titles are descriptive and non-empty", () => {
      AGENT_PRESETS.forEach((preset) => {
        // Titles should be descriptive role names
        expect(preset.title.length).toBeGreaterThan(5);
        expect(preset.title.length).toBeLessThan(50);
      });
    });
  });
});
