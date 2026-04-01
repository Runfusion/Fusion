import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @fusion/core before importing the module under test
vi.mock("@fusion/core", () => {
  const DEFAULT_SETTINGS = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    autoResolveConflicts: true,
    smartConflictResolution: true,
    requirePlanApproval: false,
    ntfyEnabled: false,
    taskPrefix: undefined,
    ntfyTopic: undefined,
    worktreeNaming: "random",
    githubTokenConfigured: false,
  };

  // Mock CentralCore for project-resolver
  const mockCentralCore = vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue(undefined),
    getProjectByPath: vi.fn().mockResolvedValue(undefined),
    registerProject: vi.fn(),
    unregisterProject: vi.fn(),
    getProjectHealth: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
  }));

  return {
    TaskStore: vi.fn(),
    CentralCore: mockCentralCore,
    DEFAULT_SETTINGS,
  };
});

// Mock project-resolver to return a simple getStore that returns a mock store
vi.mock("../project-resolver.js", async () => {
  // Create a mock store with the methods tests expect
  const createMockStore = () => ({
    init: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      autoResolveConflicts: true,
      smartConflictResolution: true,
      requirePlanApproval: false,
      ntfyEnabled: false,
      taskPrefix: undefined,
      ntfyTopic: undefined,
      worktreeNaming: "random",
      githubTokenConfigured: false,
      defaultProvider: undefined,
      defaultModelId: undefined,
      defaultThinkingLevel: undefined,
    }),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  });

  return {
    getStore: vi.fn().mockImplementation(createMockStore),
    resolveProject: vi.fn().mockRejectedValue(new Error("Not implemented in mock")),
    ProjectResolutionError: class ProjectResolutionError extends Error {
      code: string;
      context?: Record<string, unknown>;
      constructor(message: string, code: string, context?: Record<string, unknown>) {
        super(message);
        this.name = "ProjectResolutionError";
        this.code = code;
        this.context = context;
      }
    },
    getCentralCore: vi.fn(),
    getProjectManager: vi.fn(),
    findKbDir: vi.fn().mockReturnValue(null),
    isKbProject: vi.fn().mockReturnValue(true),
    suggestProjectName: vi.fn().mockReturnValue("test-project"),
    formatLastActivity: vi.fn().mockReturnValue("just now"),
    resetProjectResolution: vi.fn(),
  };
});

import { TaskStore, DEFAULT_SETTINGS } from "@fusion/core";
import { getStore } from "../project-resolver.js";
import {
  runSettingsShow,
  runSettingsSet,
  parseValue,
  VALID_SETTINGS,
} from "./settings.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe("VALID_SETTINGS", () => {
  it("contains all expected CLI-updatable settings", () => {
    expect(VALID_SETTINGS).toContain("maxConcurrent");
    expect(VALID_SETTINGS).toContain("maxWorktrees");
    expect(VALID_SETTINGS).toContain("worktreeNaming");
    expect(VALID_SETTINGS).toContain("taskPrefix");
    expect(VALID_SETTINGS).toContain("ntfyTopic");
    expect(VALID_SETTINGS).toContain("autoResolveConflicts");
    expect(VALID_SETTINGS).toContain("smartConflictResolution");
    expect(VALID_SETTINGS).toContain("requirePlanApproval");
    expect(VALID_SETTINGS).toContain("ntfyEnabled");
    expect(VALID_SETTINGS).toContain("defaultModel");
  });
});

describe("parseValue", () => {
  describe("boolean settings", () => {
    const booleanSettings = [
      "autoResolveConflicts",
      "smartConflictResolution",
      "requirePlanApproval",
      "ntfyEnabled",
    ] as const;

    for (const setting of booleanSettings) {
      describe(setting, () => {
        it('returns true for "true"', () => {
          expect(parseValue(setting, "true")).toBe(true);
        });

        it('returns true for "TRUE" (case-insensitive)', () => {
          expect(parseValue(setting, "TRUE")).toBe(true);
        });

        it('returns true for "yes"', () => {
          expect(parseValue(setting, "yes")).toBe(true);
        });

        it('returns true for "YES" (case-insensitive)', () => {
          expect(parseValue(setting, "YES")).toBe(true);
        });

        it('returns false for "false"', () => {
          expect(parseValue(setting, "false")).toBe(false);
        });

        it('returns false for "FALSE" (case-insensitive)', () => {
          expect(parseValue(setting, "FALSE")).toBe(false);
        });

        it('returns false for "no"', () => {
          expect(parseValue(setting, "no")).toBe(false);
        });

        it('returns false for "NO" (case-insensitive)', () => {
          expect(parseValue(setting, "NO")).toBe(false);
        });

        it("throws for invalid boolean values", () => {
          expect(() => parseValue(setting, "invalid")).toThrow(
            `Invalid boolean value for ${setting}: "invalid"`
          );
        });

        it("throws for empty strings", () => {
          expect(() => parseValue(setting, "")).toThrow();
        });
      });
    }
  });

  describe("number settings", () => {
    it("parses maxConcurrent as integer", () => {
      expect(parseValue("maxConcurrent", "4")).toBe(4);
    });

    it("parses maxWorktrees as integer", () => {
      expect(parseValue("maxWorktrees", "8")).toBe(8);
    });

    it("rejects non-numeric values for maxConcurrent", () => {
      expect(() => parseValue("maxConcurrent", "abc")).toThrow(
        'Invalid numeric value for maxConcurrent: "abc"'
      );
    });

    it("rejects non-numeric values for maxWorktrees", () => {
      expect(() => parseValue("maxWorktrees", "xyz")).toThrow(
        'Invalid numeric value for maxWorktrees: "xyz"'
      );
    });

    it("enforces maxConcurrent range (1-10)", () => {
      expect(() => parseValue("maxConcurrent", "0")).toThrow(
        "Value out of range for maxConcurrent: 0. Must be between 1 and 10."
      );
      expect(() => parseValue("maxConcurrent", "11")).toThrow(
        "Value out of range for maxConcurrent: 11. Must be between 1 and 10."
      );
    });

    it("enforces maxWorktrees range (1-20)", () => {
      expect(() => parseValue("maxWorktrees", "0")).toThrow(
        "Value out of range for maxWorktrees: 0. Must be between 1 and 20."
      );
      expect(() => parseValue("maxWorktrees", "21")).toThrow(
        "Value out of range for maxWorktrees: 21. Must be between 1 and 20."
      );
    });

    it("accepts boundary values", () => {
      expect(parseValue("maxConcurrent", "1")).toBe(1);
      expect(parseValue("maxConcurrent", "10")).toBe(10);
      expect(parseValue("maxWorktrees", "1")).toBe(1);
      expect(parseValue("maxWorktrees", "20")).toBe(20);
    });

    it("handles whitespace", () => {
      expect(parseValue("maxConcurrent", "  5  ")).toBe(5);
    });
  });

  describe("enum settings", () => {
    describe("worktreeNaming", () => {
      it('accepts "random"', () => {
        expect(parseValue("worktreeNaming", "random")).toBe("random");
      });

      it('accepts "task-id"', () => {
        expect(parseValue("worktreeNaming", "task-id")).toBe("task-id");
      });

      it('accepts "task-title"', () => {
        expect(parseValue("worktreeNaming", "task-title")).toBe("task-title");
      });

      it("rejects invalid enum values", () => {
        expect(() => parseValue("worktreeNaming", "invalid")).toThrow(
          'Invalid value for worktreeNaming: "invalid". Valid options: random, task-id, task-title'
        );
      });

      it("handles whitespace", () => {
        expect(parseValue("worktreeNaming", "  task-id  ")).toBe("task-id");
      });
    });
  });

  describe("string settings", () => {
    it("returns taskPrefix as trimmed string", () => {
      expect(parseValue("taskPrefix", "  TASK  ")).toBe("TASK");
    });

    it("returns ntfyTopic as trimmed string", () => {
      expect(parseValue("ntfyTopic", "  my-topic  ")).toBe("my-topic");
    });

    it("returns defaultModel as trimmed string", () => {
      expect(parseValue("defaultModel", "  anthropic/claude-4  ")).toBe("anthropic/claude-4");
    });

    it("allows empty strings to clear values", () => {
      expect(parseValue("taskPrefix", "")).toBe("");
      expect(parseValue("ntfyTopic", "")).toBe("");
    });
  });
});

describe("runSettingsShow", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays settings in formatted output", async () => {
    const mockSettings = makeSettings({
      maxConcurrent: 3,
      maxWorktrees: 6,
      autoResolveConflicts: false,
      taskPrefix: "CUSTOM",
    });

    (getStore as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      init: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(mockSettings),
    });

    await runSettingsShow();

    // Check for header
    const headerLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("kb Configuration Settings")
    );
    expect(headerLine).toBeDefined();

    // Check that maxConcurrent appears
    const maxConcurrentLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Max Concurrent")
    );
    expect(maxConcurrentLine).toBeDefined();

    // Check that group headers appear
    const engineGroup = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Engine:")
    );
    expect(engineGroup).toBeDefined();
  });

  it("shows githubTokenConfigured as configured indicator", async () => {
    const mockSettings = makeSettings({
      githubTokenConfigured: true,
    });

    (getStore as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      init: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(mockSettings),
    });

    await runSettingsShow();

    const configuredLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("(configured)")
    );
    expect(configuredLine).toBeDefined();
  });

  it("shows githubTokenConfigured as not configured indicator", async () => {
    const mockSettings = makeSettings({
      githubTokenConfigured: false,
    });

    (getStore as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      init: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(mockSettings),
    });

    await runSettingsShow();

    const notConfiguredLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("(not configured)")
    );
    expect(notConfiguredLine).toBeDefined();
  });
});

describe("runSettingsSet", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockUpdateSettings: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    mockUpdateSettings = vi.fn().mockResolvedValue({
      maxConcurrent: 4,
      maxWorktrees: 4,
    });

    (getStore as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      init: vi.fn(),
      updateSettings: mockUpdateSettings,
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 4,
        maxWorktrees: 4,
        taskPrefix: "TEST",
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates maxConcurrent with valid value", async () => {
    await runSettingsSet("maxConcurrent", "4");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ maxConcurrent: 4 });

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Updated")
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("4");
  });

  it("updates autoResolveConflicts with boolean true", async () => {
    await runSettingsSet("autoResolveConflicts", "true");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoResolveConflicts: true });

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Updated")
    );
    expect(successLine).toBeDefined();
  });

  it("updates autoResolveConflicts with boolean false", async () => {
    await runSettingsSet("autoResolveConflicts", "false");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoResolveConflicts: false });
  });

  it("updates autoResolveConflicts with 'yes'", async () => {
    await runSettingsSet("autoResolveConflicts", "yes");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoResolveConflicts: true });
  });

  it("updates autoResolveConflicts with 'no'", async () => {
    await runSettingsSet("autoResolveConflicts", "no");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoResolveConflicts: false });
  });

  it("updates worktreeNaming with valid enum", async () => {
    await runSettingsSet("worktreeNaming", "task-id");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ worktreeNaming: "task-id" });
  });

  it("updates taskPrefix with string value", async () => {
    await runSettingsSet("taskPrefix", "CUSTOM");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ taskPrefix: "CUSTOM" });
  });

  it("updates ntfyTopic with string value", async () => {
    await runSettingsSet("ntfyTopic", "my-notifications");

    expect(mockUpdateSettings).toHaveBeenCalledWith({ ntfyTopic: "my-notifications" });
  });

  it("handles defaultModel split into provider and modelId", async () => {
    await runSettingsSet("defaultModel", "anthropic/claude-sonnet-4-5");

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("anthropic/claude-sonnet-4-5")
    );
    expect(successLine).toBeDefined();
  });

  it("exits with error for unknown setting key", async () => {
    await runSettingsSet("unknownSetting", "value");

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown setting"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error for invalid boolean value", async () => {
    await runSettingsSet("autoResolveConflicts", "invalid");

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid boolean value"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error for out-of-range number", async () => {
    await runSettingsSet("maxConcurrent", "99");

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Value out of range"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error for invalid enum value", async () => {
    await runSettingsSet("worktreeNaming", "invalid");

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid value for worktreeNaming"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles defaultModel with invalid format (no slash)", async () => {
    await runSettingsSet("defaultModel", "invalid-format");

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid format for defaultModel"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
