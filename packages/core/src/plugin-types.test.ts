import { describe, it, expect } from "vitest";
import { validatePluginManifest } from "./plugin-types.js";

describe("validatePluginManifest", () => {
  // ── Valid Manifests ─────────────────────────────────────────────────

  describe("valid manifests", () => {
    it("accepts a minimal valid manifest", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts a full valid manifest with all optional fields", () => {
      const manifest = {
        id: "my-plugin",
        name: "My Plugin",
        version: "1.2.3",
        description: "A test plugin",
        author: "Test Author",
        homepage: "https://example.com",
        fusionVersion: "1.0.0",
        dependencies: ["other-plugin"],
        settingsSchema: {
          apiKey: {
            type: "string",
            label: "API Key",
            description: "Your API key",
            required: true,
          },
          maxItems: {
            type: "number",
            label: "Max Items",
            defaultValue: 10,
          },
          enabled: {
            type: "boolean",
            label: "Enable Feature",
            defaultValue: true,
          },
          color: {
            type: "enum",
            label: "Color",
            enumValues: ["red", "green", "blue"],
            defaultValue: "blue",
          },
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts manifest with version 0.0.1", () => {
      const manifest = { id: "test", name: "Test", version: "0.0.1" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts manifest with large version numbers", () => {
      const manifest = { id: "test", name: "Test", version: "100.200.300" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts manifest with empty dependencies array", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", dependencies: [] };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts manifest with multiple valid dependencies", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        dependencies: ["plugin-a", "plugin-b", "plugin-c"],
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts manifest with valid settingsSchema", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: {
          setting1: { type: "string" },
          setting2: { type: "number" },
          setting3: { type: "boolean" },
          setting4: { type: "enum", enumValues: ["a", "b"] },
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts password and array types in settingsSchema", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: {
          apiSecret: { type: "password", label: "API Secret" },
          tags: { type: "array", label: "Tags", itemType: "string" },
          scores: { type: "array", label: "Scores", itemType: "number" },
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts string with multiline option", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: {
          description: { type: "string", label: "Description", multiline: true },
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  // ── Missing Required Fields ─────────────────────────────────────────

  describe("missing required fields", () => {
    it("rejects manifest with missing id", () => {
      const manifest = { name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("id is required and must be a non-empty string");
    });

    it("rejects manifest with missing name", () => {
      const manifest = { id: "my-plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("name is required and must be a non-empty string");
    });

    it("rejects manifest with missing version", () => {
      const manifest = { id: "my-plugin", name: "My Plugin" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version is required and must be a non-empty string");
    });

    it("rejects manifest with all required fields missing", () => {
      const manifest = { description: "Only a description" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("id is required and must be a non-empty string");
      expect(result.errors).toContain("name is required and must be a non-empty string");
      expect(result.errors).toContain("version is required and must be a non-empty string");
    });
  });

  // ── Empty Strings ───────────────────────────────────────────────────

  describe("empty strings for required fields", () => {
    it("rejects manifest with empty id", () => {
      const manifest = { id: "", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("id is required and must be a non-empty string");
    });

    it("rejects manifest with whitespace-only id", () => {
      const manifest = { id: "   ", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("id is required and must be a non-empty string");
    });

    it("rejects manifest with empty name", () => {
      const manifest = { id: "my-plugin", name: "", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("name is required and must be a non-empty string");
    });

    it("rejects manifest with empty version", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version is required and must be a non-empty string");
    });
  });

  // ── Invalid ID Format ───────────────────────────────────────────────

  describe("invalid id format", () => {
    it("rejects id with uppercase letters", () => {
      const manifest = { id: "My-Plugin", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("id must be a valid slug"))).toBe(true);
    });

    it("rejects id with underscores", () => {
      const manifest = { id: "my_plugin", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("id must be a valid slug"))).toBe(true);
    });

    it("rejects id with spaces", () => {
      const manifest = { id: "my plugin", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("id must be a valid slug"))).toBe(true);
    });

    it("rejects id starting with a hyphen", () => {
      const manifest = { id: "-my-plugin", name: "My Plugin", version: "1.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("id must be a valid slug"))).toBe(true);
    });
  });

  // ── Invalid Version Format ──────────────────────────────────────────

  describe("invalid version format", () => {
    it("rejects version without semver format", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "latest" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version must be a valid semver string (e.g., 1.0.0)");
    });

    it("rejects version with only major number", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "1" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version must be a valid semver string (e.g., 1.0.0)");
    });

    it("rejects version with only two parts", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "1.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version must be a valid semver string (e.g., 1.0.0)");
    });

    it("rejects version with four parts", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "1.0.0.0" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version must be a valid semver string (e.g., 1.0.0)");
    });

    it("rejects version with letters", () => {
      const manifest = { id: "my-plugin", name: "My Plugin", version: "1.0.0-beta" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("version must be a valid semver string (e.g., 1.0.0)");
    });

    it("accepts version with leading zero (1.02.03)", () => {
      // This is technically valid semver syntax (though unusual)
      const manifest = { id: "my-plugin", name: "My Plugin", version: "1.02.03" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  // ── Invalid Dependencies ────────────────────────────────────────────

  describe("invalid dependencies", () => {
    it("rejects non-array dependencies", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", dependencies: "not-an-array" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("dependencies must be an array");
    });

    it("rejects dependencies with non-string items", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", dependencies: ["valid", 123, "also-valid"] };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("All dependencies must be non-empty strings");
    });

    it("rejects dependencies with empty string items", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", dependencies: ["valid", "", "also-valid"] };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("All dependencies must be non-empty strings");
    });

    it("rejects dependencies with whitespace-only string items", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", dependencies: ["  "] };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("All dependencies must be non-empty strings");
    });
  });

  // ── Invalid settingsSchema ────────────────────────────────────────

  describe("invalid settingsSchema", () => {
    it("rejects non-object settingsSchema", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", settingsSchema: "not-an-object" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("settingsSchema must be an object");
    });

    it("rejects null settingsSchema", () => {
      const manifest = { id: "test", name: "Test", version: "1.0.0", settingsSchema: null };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("settingsSchema must be an object");
    });

    it("rejects setting with invalid type", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: { setting1: { type: "invalid-type" } },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "settingsSchema.setting1.type must be one of: string, number, boolean, enum, password, array",
      );
    });

    it("rejects enum setting without enumValues", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: { setting1: { type: "enum" } },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "settingsSchema.setting1.enumValues is required and must be a non-empty array when type is enum",
      );
    });

    it("rejects enum setting with empty enumValues", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: { setting1: { type: "enum", enumValues: [] } },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "settingsSchema.setting1.enumValues is required and must be a non-empty array when type is enum",
      );
    });

    it("rejects array type without itemType", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: { setting1: { type: "array" } },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "settingsSchema.setting1.itemType is required and must be \"string\" or \"number\" when type is array",
      );
    });

    it("rejects array type with invalid itemType", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: { setting1: { type: "array", itemType: "boolean" } },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "settingsSchema.setting1.itemType is required and must be \"string\" or \"number\" when type is array",
      );
    });

    it("rejects multiple invalid settings", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        settingsSchema: {
          setting1: { type: "invalid" },
          setting2: { type: "enum" },
          setting3: { type: "string" },
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Null/Undefined Input ────────────────────────────────────────────

  describe("null/undefined input", () => {
    it("rejects null manifest", () => {
      const result = validatePluginManifest(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Manifest is required");
    });

    it("rejects undefined manifest", () => {
      const result = validatePluginManifest(undefined);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Manifest is required");
    });

    it("rejects non-object manifest", () => {
      const result = validatePluginManifest("string");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Manifest must be an object");
    });

    it("rejects number manifest", () => {
      const result = validatePluginManifest(123);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Manifest must be an object");
    });

    it("rejects array manifest", () => {
      const result = validatePluginManifest([]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Manifest must be an object");
    });
  });

  // ── Error Message Quality ───────────────────────────────────────────

  describe("error message quality", () => {
    it("returns all errors, not just the first one", () => {
      const manifest = { id: "", name: "", version: "" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);
    });

    it("errors are descriptive enough to fix the issue", () => {
      const manifest = { id: "Invalid-ID", name: "", version: "bad" };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      // Each error should give clear guidance
      expect(result.errors.some((e) => e.includes("id"))).toBe(true);
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });
  });
});
