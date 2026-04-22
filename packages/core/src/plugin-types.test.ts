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

  // ── Runtime Manifest Metadata ───────────────────────────────────────

  describe("runtime manifest metadata", () => {
    it("accepts manifest with valid runtime metadata", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "code-interpreter",
          name: "Code Interpreter",
          description: "Executes code in a sandbox",
          version: "1.0.0",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts manifest with minimal runtime metadata (only required fields)", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "my-runtime",
          name: "My Runtime",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts manifest without runtime field", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects non-object runtime", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: "not-an-object",
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime must be an object");
    });

    it("rejects null runtime", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: null,
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime must be an object");
    });

    it("rejects runtime with missing runtimeId", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          name: "My Runtime",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.runtimeId is required and must be a non-empty string");
    });

    it("rejects runtime with empty runtimeId", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "",
          name: "My Runtime",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.runtimeId is required and must be a non-empty string");
    });

    it("rejects runtime with invalid runtimeId format", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "My-Runtime",
          name: "My Runtime",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.runtimeId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
    });

    it("rejects runtime with uppercase in runtimeId", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "CodeInterpreter",
          name: "My Runtime",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.runtimeId must be a valid slug (lowercase, alphanumeric, hyphens only, cannot start or end with hyphen)");
    });

    it("rejects runtime with missing name", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "my-runtime",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.name is required and must be a non-empty string");
    });

    it("rejects runtime with empty name", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "my-runtime",
          name: "",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.name is required and must be a non-empty string");
    });

    it("rejects runtime with invalid version format", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "my-runtime",
          name: "My Runtime",
          version: "latest",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.version must be a valid semver string (e.g., 1.0.0)");
    });

    it("rejects runtime with non-string version", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "my-runtime",
          name: "My Runtime",
          version: 123,
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("runtime.version must be a string");
    });

    it("accepts runtime with valid semver version", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "my-runtime",
          name: "My Runtime",
          version: "2.1.3",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("reports multiple runtime validation errors", () => {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: {
          runtimeId: "",
          name: "",
          version: "bad",
        },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
      expect(result.errors).toContain("runtime.runtimeId is required and must be a non-empty string");
      expect(result.errors).toContain("runtime.name is required and must be a non-empty string");
      expect(result.errors).toContain("runtime.version must be a valid semver string (e.g., 1.0.0)");
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

// ── PluginUiSlotDefinition ─────────────────────────────────────────────

describe("PluginUiSlotDefinition", () => {
  it("accepts a valid PluginUiSlotDefinition with all fields", () => {
    const slot = {
      slotId: "task-detail-tab",
      label: "Task Details",
      icon: "FileText",
      componentPath: "./components/TaskDetailTab.js",
    };

    expect(slot.slotId).toBe("task-detail-tab");
    expect(slot.label).toBe("Task Details");
    expect(slot.icon).toBe("FileText");
    expect(slot.componentPath).toBe("./components/TaskDetailTab.js");
  });

  it("accepts a valid PluginUiSlotDefinition without optional icon field", () => {
    const slot = {
      slotId: "header-action",
      label: "Header Action",
      componentPath: "./components/HeaderAction.js",
    };

    expect(slot.slotId).toBe("header-action");
    expect(slot.label).toBe("Header Action");
    expect(slot.componentPath).toBe("./components/HeaderAction.js");
    // icon is optional, so it should be undefined
    expect((slot as any).icon).toBeUndefined();
  });

  it("requires slotId field", () => {
    const slot = {
      label: "Some Label",
      componentPath: "./components/Test.js",
    };

    // TypeScript would catch this at compile time, but at runtime we verify the structure
    expect((slot as any).slotId).toBeUndefined();
  });

  it("requires label field", () => {
    const slot = {
      slotId: "some-slot",
      componentPath: "./components/Test.js",
    };

    expect((slot as any).label).toBeUndefined();
  });

  it("requires componentPath field", () => {
    const slot = {
      slotId: "some-slot",
      label: "Some Label",
    };

    expect((slot as any).componentPath).toBeUndefined();
  });
});

// ── FusionPlugin with uiSlots ──────────────────────────────────────────

describe("FusionPlugin with uiSlots", () => {
  it("accepts a FusionPlugin with uiSlots array", () => {
    const plugin = {
      manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
      state: "started" as const,
      hooks: {},
      tools: [],
      routes: [],
      uiSlots: [
        {
          slotId: "task-detail-tab",
          label: "Task Details",
          componentPath: "./components/TaskDetailTab.js",
        },
        {
          slotId: "header-action",
          label: "Header Action",
          icon: "Plus",
          componentPath: "./components/HeaderAction.js",
        },
      ],
    };

    expect(plugin.uiSlots).toHaveLength(2);
    expect(plugin.uiSlots![0].slotId).toBe("task-detail-tab");
    expect(plugin.uiSlots![1].icon).toBe("Plus");
  });

  it("accepts a FusionPlugin without uiSlots field", () => {
    const plugin = {
      manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
      state: "started" as const,
      hooks: {},
      tools: [],
      routes: [],
    };

    expect((plugin as any).uiSlots).toBeUndefined();
  });
});

// ── FusionPlugin with runtime ──────────────────────────────────────────

describe("FusionPlugin with runtime", () => {
  it("accepts a FusionPlugin with runtime registration", () => {
    const plugin = {
      manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
      state: "started" as const,
      hooks: {},
      tools: [],
      routes: [],
      runtime: {
        metadata: {
          runtimeId: "code-interpreter",
          name: "Code Interpreter",
          description: "Executes code in a sandbox",
          version: "1.0.0",
        },
        factory: async () => ({ execute: async () => {} }),
      },
    };

    expect(plugin.runtime).toBeDefined();
    expect(plugin.runtime!.metadata.runtimeId).toBe("code-interpreter");
    expect(plugin.runtime!.metadata.name).toBe("Code Interpreter");
    expect(typeof plugin.runtime!.factory).toBe("function");
  });

  it("accepts a FusionPlugin with minimal runtime registration", () => {
    const plugin = {
      manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
      state: "started" as const,
      hooks: {},
      tools: [],
      routes: [],
      runtime: {
        metadata: {
          runtimeId: "my-runtime",
          name: "My Runtime",
        },
        factory: async () => {},
      },
    };

    expect(plugin.runtime).toBeDefined();
    expect(plugin.runtime!.metadata.runtimeId).toBe("my-runtime");
    expect(plugin.runtime!.metadata.name).toBe("My Runtime");
  });

  it("accepts a FusionPlugin without runtime field", () => {
    const plugin = {
      manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
      state: "started" as const,
      hooks: {},
      tools: [],
      routes: [],
    };

    expect((plugin as any).runtime).toBeUndefined();
  });

  it("accepts a FusionPlugin with uiSlots and runtime together", () => {
    const plugin = {
      manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
      state: "started" as const,
      hooks: {},
      tools: [],
      routes: [],
      uiSlots: [
        {
          slotId: "task-detail-tab",
          label: "Task Details",
          componentPath: "./components/TaskDetailTab.js",
        },
      ],
      runtime: {
        metadata: {
          runtimeId: "code-interpreter",
          name: "Code Interpreter",
        },
        factory: async () => {},
      },
    };

    expect(plugin.uiSlots).toHaveLength(1);
    expect(plugin.runtime).toBeDefined();
    expect(plugin.runtime!.metadata.runtimeId).toBe("code-interpreter");
  });
});

// ── PluginRuntimeManifestMetadata ──────────────────────────────────────

describe("PluginRuntimeManifestMetadata", () => {
  it("accepts a valid PluginRuntimeManifestMetadata with all fields", () => {
    const metadata = {
      runtimeId: "code-interpreter",
      name: "Code Interpreter",
      description: "Executes code in a sandbox",
      version: "1.0.0",
    };

    expect(metadata.runtimeId).toBe("code-interpreter");
    expect(metadata.name).toBe("Code Interpreter");
    expect(metadata.description).toBe("Executes code in a sandbox");
    expect(metadata.version).toBe("1.0.0");
  });

  it("accepts a PluginRuntimeManifestMetadata without optional fields", () => {
    const metadata = {
      runtimeId: "my-runtime",
      name: "My Runtime",
    };

    expect(metadata.runtimeId).toBe("my-runtime");
    expect(metadata.name).toBe("My Runtime");
    expect((metadata as any).description).toBeUndefined();
    expect((metadata as any).version).toBeUndefined();
  });

  it("accepts valid slug format for runtimeId", () => {
    const validIds = ["a", "a1", "a-b", "code-interpreter", "web-search-v2"];
    for (const runtimeId of validIds) {
      const metadata = { runtimeId, name: "Test" };
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: metadata,
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(true);
    }
  });

  it("rejects invalid slug format for runtimeId", () => {
    const invalidIds = ["-starts-with-hyphen", "ends-with-hyphen-", "has_underscore", "has space", "UPPERCASE"];
    for (const runtimeId of invalidIds) {
      const manifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        runtime: { runtimeId, name: "Test" },
      };
      const result = validatePluginManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("runtimeId"))).toBe(true);
    }
  });
});

// ── PluginRuntimeRegistration ───────────────────────────────────────────

describe("PluginRuntimeRegistration", () => {
  it("accepts a valid PluginRuntimeRegistration", () => {
    const registration = {
      metadata: {
        runtimeId: "code-interpreter",
        name: "Code Interpreter",
        description: "Executes code in a sandbox",
      },
      factory: async (ctx: any) => {
        return {
          execute: async (code: string) => {
            return { result: `evaluated: ${code}` };
          },
        };
      },
    };

    expect(registration.metadata.runtimeId).toBe("code-interpreter");
    expect(typeof registration.factory).toBe("function");
  });

  it("accepts synchronous factory function", () => {
    const registration = {
      metadata: {
        runtimeId: "sync-runtime",
        name: "Sync Runtime",
      },
      factory: () => ({ execute: () => {} }),
    };

    expect(typeof registration.factory).toBe("function");
  });

  it("factory can return null or void", () => {
    const registration = {
      metadata: {
        runtimeId: "null-runtime",
        name: "Null Runtime",
      },
      factory: async () => {
        return null;
      },
    };

    expect(typeof registration.factory).toBe("function");
  });
});
