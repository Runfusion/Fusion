import { describe, it, expect } from "vitest";
import {
  PROMPT_KEY_CATALOG,
  PromptKey,
  PromptOverrideMap,
  resolvePrompt,
  resolveRolePrompts,
  hasRoleOverrides,
  getOverriddenKeys,
  clearOverrides,
  getPromptKeyMetadata,
  getPromptKeysForRole,
  isValidPromptKey,
  isValidPromptOverrideMap,
  assertValidPromptOverrideMap,
} from "./prompt-overrides.js";

describe("prompt-overrides", () => {
  describe("PROMPT_KEY_CATALOG", () => {
    it("should contain all expected prompt keys", () => {
      const expectedKeys: PromptKey[] = [
        "executor-welcome",
        "executor-guardrails",
        "executor-spawning",
        "executor-completion",
        "triage-welcome",
        "triage-context",
        "reviewer-verdict",
        "merger-conflicts",
      ];

      for (const key of expectedKeys) {
        expect(PROMPT_KEY_CATALOG).toHaveProperty(key);
        expect(PROMPT_KEY_CATALOG[key].key).toBe(key);
      }
    });

    it("should have valid metadata for each key", () => {
      for (const [key, meta] of Object.entries(PROMPT_KEY_CATALOG)) {
        expect(meta.key).toBe(key);
        expect(typeof meta.name).toBe("string");
        expect(meta.name.length).toBeGreaterThan(0);
        expect(Array.isArray(meta.roles)).toBe(true);
        expect(meta.roles.length).toBeGreaterThan(0);
        expect(typeof meta.description).toBe("string");
        expect(typeof meta.defaultContent).toBe("string");
        expect(meta.defaultContent.length).toBeGreaterThan(0);
      }
    });

    it("should have appropriate roles for each key", () => {
      // Executor keys should only be for executor role
      expect(PROMPT_KEY_CATALOG["executor-welcome"].roles).toContain("executor");
      expect(PROMPT_KEY_CATALOG["executor-guardrails"].roles).toContain("executor");
      expect(PROMPT_KEY_CATALOG["executor-spawning"].roles).toContain("executor");
      expect(PROMPT_KEY_CATALOG["executor-completion"].roles).toContain("executor");

      // Triage keys should only be for triage role
      expect(PROMPT_KEY_CATALOG["triage-welcome"].roles).toContain("triage");
      expect(PROMPT_KEY_CATALOG["triage-context"].roles).toContain("triage");

      // Reviewer and merger keys
      expect(PROMPT_KEY_CATALOG["reviewer-verdict"].roles).toContain("reviewer");
      expect(PROMPT_KEY_CATALOG["merger-conflicts"].roles).toContain("merger");
    });
  });

  describe("getPromptKeyMetadata", () => {
    it("should return metadata for valid keys", () => {
      const meta = getPromptKeyMetadata("executor-welcome");
      expect(meta).toBeDefined();
      expect(meta?.key).toBe("executor-welcome");
      expect(meta?.name).toBe("Executor Welcome");
    });

    it("should return undefined for invalid keys", () => {
      expect(getPromptKeyMetadata("invalid-key" as PromptKey)).toBeUndefined();
      expect(getPromptKeyMetadata("" as PromptKey)).toBeUndefined();
    });
  });

  describe("getPromptKeysForRole", () => {
    it("should return all keys for executor role", () => {
      const keys = getPromptKeysForRole("executor");
      expect(keys).toHaveLength(6);
      expect(keys.map((k) => k.key)).toContain("executor-welcome");
      expect(keys.map((k) => k.key)).toContain("executor-guardrails");
      expect(keys.map((k) => k.key)).toContain("executor-spawning");
      expect(keys.map((k) => k.key)).toContain("executor-completion");
      expect(keys.map((k) => k.key)).toContain("agent-generation-system");
      expect(keys.map((k) => k.key)).toContain("workflow-step-refine");
    });

    it("should return all keys for triage role", () => {
      const keys = getPromptKeysForRole("triage");
      expect(keys).toHaveLength(2);
      expect(keys.map((k) => k.key)).toContain("triage-welcome");
      expect(keys.map((k) => k.key)).toContain("triage-context");
    });

    it("should return single key for reviewer role", () => {
      const keys = getPromptKeysForRole("reviewer");
      expect(keys).toHaveLength(1);
      expect(keys[0].key).toBe("reviewer-verdict");
    });

    it("should return single key for merger role", () => {
      const keys = getPromptKeysForRole("merger");
      expect(keys).toHaveLength(1);
      expect(keys[0].key).toBe("merger-conflicts");
    });
  });

  describe("resolvePrompt", () => {
    it("should return override when present and non-empty", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom executor welcome",
      };

      const result = resolvePrompt("executor-welcome", overrides);
      expect(result).toBe("Custom executor welcome");
    });

    it("should return default when no override present", () => {
      const overrides: PromptOverrideMap = {};
      const defaultContent = PROMPT_KEY_CATALOG["executor-welcome"].defaultContent;

      const result = resolvePrompt("executor-welcome", overrides);
      expect(result).toBe(defaultContent);
    });

    it("should return default when override is empty string", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "",
      };
      const defaultContent = PROMPT_KEY_CATALOG["executor-welcome"].defaultContent;

      const result = resolvePrompt("executor-welcome", overrides);
      expect(result).toBe(defaultContent);
    });

    it("should return default when override is undefined", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": undefined,
      };
      const defaultContent = PROMPT_KEY_CATALOG["executor-welcome"].defaultContent;

      const result = resolvePrompt("executor-welcome", overrides);
      expect(result).toBe(defaultContent);
    });

    it("should return default when overrides is undefined", () => {
      const defaultContent = PROMPT_KEY_CATALOG["executor-welcome"].defaultContent;

      const result = resolvePrompt("executor-welcome", undefined);
      expect(result).toBe(defaultContent);
    });

    it("should return default for unrecognized key", () => {
      const result = resolvePrompt("invalid-key" as PromptKey, {});
      expect(result).toBe("");
    });

    it("should return empty string for unrecognized key with no defaults", () => {
      const result = resolvePrompt("invalid-key" as PromptKey, undefined);
      expect(result).toBe("");
    });
  });

  describe("resolveRolePrompts", () => {
    it("should resolve all prompts for executor role", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom welcome",
      };

      const result = resolveRolePrompts("executor", overrides);

      // Custom override
      expect(result["executor-welcome"]).toBe("Custom welcome");

      // Defaults for others
      expect(result["executor-guardrails"]).toBe(PROMPT_KEY_CATALOG["executor-guardrails"].defaultContent);
      expect(result["executor-spawning"]).toBe(PROMPT_KEY_CATALOG["executor-spawning"].defaultContent);
      expect(result["executor-completion"]).toBe(PROMPT_KEY_CATALOG["executor-completion"].defaultContent);
    });

    it("should resolve all prompts for triage role", () => {
      const overrides: PromptOverrideMap = {
        "triage-welcome": "Custom triage welcome",
      };

      const result = resolveRolePrompts("triage", overrides);

      expect(result["triage-welcome"]).toBe("Custom triage welcome");
      expect(result["triage-context"]).toBe(PROMPT_KEY_CATALOG["triage-context"].defaultContent);
    });

    it("should return all defaults when no overrides", () => {
      const result = resolveRolePrompts("executor", undefined);

      for (const [key, content] of Object.entries(result)) {
        expect(content).toBe(PROMPT_KEY_CATALOG[key as PromptKey].defaultContent);
      }
    });

    it("should return empty object for roles with no prompts", () => {
      // Scheduler and custom roles have no defined prompts
      const result = resolveRolePrompts("scheduler" as any, {});
      expect(result).toEqual({});
    });
  });

  describe("hasRoleOverrides", () => {
    it("should return true when at least one override is set", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom",
      };

      expect(hasRoleOverrides("executor", overrides)).toBe(true);
    });

    it("should return false when no overrides set", () => {
      expect(hasRoleOverrides("executor", {})).toBe(false);
      expect(hasRoleOverrides("executor", undefined)).toBe(false);
    });

    it("should return false when overrides are empty strings", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "",
      };

      expect(hasRoleOverrides("executor", overrides)).toBe(false);
    });

    it("should return false when only other role has overrides", () => {
      const overrides: PromptOverrideMap = {
        "triage-welcome": "Custom",
      };

      expect(hasRoleOverrides("executor", overrides)).toBe(false);
    });
  });

  describe("getOverriddenKeys", () => {
    it("should return keys with non-empty overrides", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom",
        "triage-welcome": "Custom triage",
        "merger-conflicts": "",
      };

      const result = getOverriddenKeys(overrides);
      expect(result).toContain("executor-welcome");
      expect(result).toContain("triage-welcome");
      expect(result).not.toContain("merger-conflicts");
    });

    it("should return empty array for undefined", () => {
      expect(getOverriddenKeys(undefined)).toEqual([]);
    });

    it("should return empty array for empty object", () => {
      expect(getOverriddenKeys({})).toEqual([]);
    });
  });

  describe("clearOverrides", () => {
    it("should remove specified keys", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom",
        "executor-guardrails": "Custom guardrails",
      };

      const result = clearOverrides(overrides, ["executor-welcome"]);

      expect(result).not.toHaveProperty("executor-welcome");
      expect(result?.["executor-guardrails"]).toBe("Custom guardrails");
    });

    it("should return undefined when all keys are cleared", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom",
      };

      const result = clearOverrides(overrides, ["executor-welcome"]);

      expect(result).toBeUndefined();
    });

    it("should handle undefined input", () => {
      const result = clearOverrides(undefined, ["executor-welcome"]);

      expect(result).toBeUndefined();
    });

    it("should preserve other keys when clearing", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Custom",
        "triage-welcome": "Custom triage",
      };

      const result = clearOverrides(overrides, ["executor-welcome"]);

      expect(result?.["triage-welcome"]).toBe("Custom triage");
    });
  });

  describe("isValidPromptKey", () => {
    it("should return true for valid keys", () => {
      expect(isValidPromptKey("executor-welcome")).toBe(true);
      expect(isValidPromptKey("merger-conflicts")).toBe(true);
    });

    it("should return false for invalid keys", () => {
      expect(isValidPromptKey("invalid")).toBe(false);
      expect(isValidPromptKey("")).toBe(false);
      expect(isValidPromptKey(123 as any)).toBe(false);
      expect(isValidPromptKey(null)).toBe(false);
    });
  });

  describe("isValidPromptOverrideMap", () => {
    it("should return true for valid maps", () => {
      expect(isValidPromptOverrideMap({})).toBe(true);
      expect(isValidPromptOverrideMap({ "executor-welcome": "Custom" })).toBe(true);
      expect(isValidPromptOverrideMap({ "executor-welcome": undefined })).toBe(true);
      expect(isValidPromptOverrideMap({ "executor-welcome": "", "triage-welcome": "Custom" })).toBe(true);
    });

    it("should return false for invalid values", () => {
      expect(isValidPromptOverrideMap(null)).toBe(false);
      expect(isValidPromptOverrideMap("string")).toBe(false);
      expect(isValidPromptOverrideMap(123)).toBe(false);
      expect(isValidPromptOverrideMap({ "invalid-key": "value" })).toBe(false);
      expect(isValidPromptOverrideMap({ "executor-welcome": 123 as any })).toBe(false);
    });
  });

  describe("assertValidPromptOverrideMap", () => {
    it("should not throw for valid maps", () => {
      expect(() => assertValidPromptOverrideMap({})).not.toThrow();
      expect(() => assertValidPromptOverrideMap({ "executor-welcome": "Custom" })).not.toThrow();
    });

    it("should throw for invalid maps", () => {
      expect(() => assertValidPromptOverrideMap(null)).toThrow();
      expect(() => assertValidPromptOverrideMap({ "invalid": "value" })).toThrow();
    });
  });

  describe("fallback behavior", () => {
    it("should always return a string (never undefined or throw)", () => {
      // All valid keys should return strings
      for (const key of Object.keys(PROMPT_KEY_CATALOG) as PromptKey[]) {
        expect(typeof resolvePrompt(key, undefined)).toBe("string");
        expect(typeof resolvePrompt(key, {})).toBe("string");
        expect(typeof resolvePrompt(key, { [key]: undefined })).toBe("string");
      }
    });

    it("should handle partial overrides gracefully", () => {
      const overrides: PromptOverrideMap = {
        "executor-welcome": "Only this is overridden",
        // Other keys intentionally not set
      };

      // Should not throw
      const result = resolveRolePrompts("executor", overrides);

      // Overridden key should have custom value
      expect(result["executor-welcome"]).toBe("Only this is overridden");

      // Other keys should have defaults
      expect(result["executor-guardrails"]).toBe(PROMPT_KEY_CATALOG["executor-guardrails"].defaultContent);
      expect(result["executor-spawning"]).toBe(PROMPT_KEY_CATALOG["executor-spawning"].defaultContent);
      expect(result["executor-completion"]).toBe(PROMPT_KEY_CATALOG["executor-completion"].defaultContent);
    });
  });
});
