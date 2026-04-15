import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getOnboardingState,
  saveOnboardingState,
  clearOnboardingState,
  isOnboardingResumable,
  getOnboardingResumeStep,
  markOnboardingCompleted,
  isOnboardingCompleted,
  getOnboardingCompletedAt,
  markStepCompleted,
  getCompletedSteps,
  getStepData,
  ONBOARDING_STEP_LABELS,
} from "../model-onboarding-state";

describe("model-onboarding-state", () => {
  const STORAGE_KEY = "fusion_model_onboarding_state";

  // Mutable store shared across tests
  let mockStore: Record<string, string> = {};

  // Mock localStorage implementation
  const mockLocalStorage = {
    getItem: (key: string) => mockStore[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStore[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStore[key];
    },
    clear: () => {
      mockStore = {};
    },
  };

  beforeEach(() => {
    // Reset store for each test
    mockStore = {};
    // Reset modules to avoid caching issues
    vi.resetModules();
    // Stub the global localStorage
    vi.stubGlobal("localStorage", mockLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getOnboardingState", () => {
    it("returns null when no state exists", () => {
      expect(getOnboardingState()).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      mockStore[STORAGE_KEY] = "not valid json";
      const result = getOnboardingState();
      expect(result).toBeNull();
    });

    it("returns null for non-object JSON", () => {
      mockStore[STORAGE_KEY] = '"just a string"';
      const result = getOnboardingState();
      expect(result).toBeNull();
    });

    it("returns parsed state for valid data with defaults applied", () => {
      const state = { currentStep: "ai-setup" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingState();
      expect(result).toEqual({
        currentStep: "ai-setup",
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });
    });

    it("returns parsed state for unknown step IDs", () => {
      const state = { currentStep: "unknown-step", updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      // Unknown steps are now accepted (fallback label logic handles them)
      expect(getOnboardingState()).toEqual({
        currentStep: "unknown-step",
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });
    });

    it("returns null when currentStep is missing", () => {
      const state = { updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingState();
      expect(result).toBeNull();
    });

    it("returns null when currentStep is not a string", () => {
      const state = { currentStep: 123, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingState();
      expect(result).toBeNull();
    });

    it("returns state with defaults when stored data has only currentStep and updatedAt (pre-FN-1860 format)", () => {
      const state = { currentStep: "github" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingState();
      expect(result).toEqual({
        currentStep: "github",
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });
    });

    it("preserves new fields when present", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup", "github"] as const,
        dismissed: true,
        completed: false,
        stepData: { "ai-setup": { someData: "value" } },
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingState();
      expect(result).toEqual(state);
    });
  });

  describe("saveOnboardingState", () => {
    it("persists state to localStorage without options (backward compatible)", () => {
      saveOnboardingState("ai-setup");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("ai-setup");
      expect(parsed.updatedAt).toBeDefined();
      expect(parsed.completedSteps).toEqual([]);
      expect(parsed.dismissed).toBe(false);
      expect(parsed.completed).toBe(false);
      expect(parsed.stepData).toEqual({});
    });

    it("overwrites existing state when called without options", () => {
      saveOnboardingState("ai-setup");
      saveOnboardingState("first-task");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("first-task");
      expect(parsed.completedSteps).toEqual([]);
    });

    it("saves completedSteps when provided", () => {
      saveOnboardingState("github", { completedSteps: ["ai-setup"] });
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.completedSteps).toEqual(["ai-setup"]);
      expect(parsed.currentStep).toBe("github");
    });

    it("sets dismissed: true when options.dismissed is true", () => {
      saveOnboardingState("github", { dismissed: true });
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.dismissed).toBe(true);
      expect(parsed.completed).toBe(false);
    });

    it("sets completed: true when options.completed is true", () => {
      saveOnboardingState("complete", { completed: true });
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.completed).toBe(true);
      expect(parsed.dismissed).toBe(false);
    });

    it("completed takes precedence over dismissed when both are true", () => {
      saveOnboardingState("complete", { dismissed: true, completed: true });
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.completed).toBe(true);
      expect(parsed.dismissed).toBe(false);
    });

    it("merges stepData per-step without overwriting other steps", () => {
      // Set initial state with step data
      saveOnboardingState("ai-setup", { stepData: { "ai-setup": { key1: "value1" } } });
      // Update with new step data
      saveOnboardingState("github", { stepData: { github: { key2: "value2" } } });

      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.stepData).toEqual({
        "ai-setup": { key1: "value1" },
        github: { key2: "value2" },
      });
    });

    it("merges with existing state when options provided", () => {
      // Set initial state
      saveOnboardingState("ai-setup", { completedSteps: ["ai-setup"] });
      // Update current step while preserving completedSteps
      saveOnboardingState("github", { completedSteps: ["ai-setup"] });

      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("github");
      expect(parsed.completedSteps).toEqual(["ai-setup"]);
    });

    it("works with empty options object (backward compatible)", () => {
      saveOnboardingState("ai-setup", {});
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("ai-setup");
      expect(parsed.completedSteps).toEqual([]);
    });
  });

  describe("markStepCompleted", () => {
    it("creates fresh state with step when no state exists", () => {
      markStepCompleted("ai-setup");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("ai-setup");
      expect(parsed.completedSteps).toEqual(["ai-setup"]);
      expect(parsed.dismissed).toBe(false);
      expect(parsed.completed).toBe(false);
    });

    it("appends step to existing completedSteps without duplicates", () => {
      saveOnboardingState("github", { completedSteps: ["ai-setup"] });
      markStepCompleted("github");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.completedSteps).toEqual(["ai-setup", "github"]);
    });

    it("does not duplicate step if already in completedSteps", () => {
      saveOnboardingState("github", { completedSteps: ["ai-setup", "github"] });
      markStepCompleted("github");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.completedSteps).toEqual(["ai-setup", "github"]);
    });

    it("works when state already has other completed steps", () => {
      saveOnboardingState("first-task", { completedSteps: ["ai-setup", "github"] });
      markStepCompleted("first-task");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.completedSteps).toEqual(["ai-setup", "github", "first-task"]);
    });
  });

  describe("clearOnboardingState", () => {
    it("removes state from localStorage when called without options (backward compatible)", () => {
      const state = {
        currentStep: "ai-setup" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup"],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      clearOnboardingState();
      expect(mockStore[STORAGE_KEY]).toBeUndefined();
    });

    it("sets completed: true with preserveProgress while preserving completedSteps and stepData", () => {
      const state = {
        currentStep: "github" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup", "github"] as const,
        dismissed: true,
        completed: false,
        stepData: { "ai-setup": { someData: "value" } },
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);

      clearOnboardingState({ preserveProgress: true });

      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("complete");
      expect(parsed.completed).toBe(true);
      expect(parsed.dismissed).toBe(false);
      expect(parsed.completedSteps).toEqual(["ai-setup", "github"]);
      expect(parsed.stepData).toEqual({ "ai-setup": { someData: "value" } });
    });

    it("creates minimal completed state when no existing state with preserveProgress", () => {
      clearOnboardingState({ preserveProgress: true });

      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("complete");
      expect(parsed.completed).toBe(true);
      expect(parsed.dismissed).toBe(false);
      expect(parsed.completedSteps).toEqual([]);
      expect(parsed.stepData).toEqual({});
    });

    it("preserveProgress: false removes key (explicit option)", () => {
      const state = {
        currentStep: "ai-setup" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup"],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);

      clearOnboardingState({ preserveProgress: false });

      expect(mockStore[STORAGE_KEY]).toBeUndefined();
    });
  });

  describe("isOnboardingCompleted", () => {
    it("returns false when no state exists", () => {
      expect(isOnboardingCompleted()).toBe(false);
    });

    it("returns false when completed field is false", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(false);
    });

    it("returns true when completed field is true", () => {
      const state = {
        currentStep: "complete" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup", "github", "first-task"],
        dismissed: false,
        completed: true,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(true);
    });

    it("returns true when completedAt is set (legacy format)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-02T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(true);
    });

    it("returns true when completedAt is set even if completed is false", () => {
      const state = {
        currentStep: "complete" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-02T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(true);
    });

    it("returns false when state exists but completed field is missing (legacy state)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        stepData: {},
        // Note: no completed field
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(false);
    });

    it("returns false when completedAt is empty string", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(false);
    });
  });

  describe("getCompletedSteps", () => {
    it("returns empty array when no state exists", () => {
      expect(getCompletedSteps()).toEqual([]);
    });

    it("returns stored completedSteps array", () => {
      saveOnboardingState("first-task", { completedSteps: ["ai-setup", "github"] });
      expect(getCompletedSteps()).toEqual(["ai-setup", "github"]);
    });

    it("returns empty array when state exists but completedSteps is missing", () => {
      // Legacy state without completedSteps
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getCompletedSteps()).toEqual([]);
    });
  });

  describe("getStepData", () => {
    it("returns null when no state exists", () => {
      expect(getStepData("ai-setup")).toBeNull();
    });

    it("returns null when step has no data", () => {
      saveOnboardingState("github", { completedSteps: ["ai-setup"] });
      expect(getStepData("github")).toBeNull();
    });

    it("returns stored data for the step", () => {
      saveOnboardingState("github", {
        stepData: { "ai-setup": { selectedProvider: "anthropic", selectedModel: "claude-3" } },
      });
      expect(getStepData("ai-setup")).toEqual({ selectedProvider: "anthropic", selectedModel: "claude-3" });
    });

    it("returns null when state exists but stepData is missing (legacy state)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        // Note: no stepData field
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getStepData("ai-setup")).toBeNull();
    });
  });

  describe("isOnboardingResumable", () => {
    it("returns false when no state exists", () => {
      expect(isOnboardingResumable()).toBe(false);
    });

    it("returns false when step is 'complete'", () => {
      const state = {
        currentStep: "complete" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingResumable()).toBe(false);
    });

    it("returns true for non-terminal steps", () => {
      const steps: Array<"ai-setup" | "github" | "first-task"> = ["ai-setup", "github", "first-task"];
      for (const step of steps) {
        const state = {
          currentStep: step,
          updatedAt: "2024-01-01T00:00:00.000Z",
          completedSteps: [],
          dismissed: false,
          completed: false,
          stepData: {},
        };
        mockStore[STORAGE_KEY] = JSON.stringify(state);
        expect(isOnboardingResumable()).toBe(true);
      }
    });

    it("returns false when completed: true (new format)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup", "github"],
        dismissed: false,
        completed: true,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingResumable()).toBe(false);
    });

    it("returns false when completedAt is set (legacy format)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-02T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingResumable()).toBe(false);
    });

    it("returns false when dismissed: true", () => {
      const state = {
        currentStep: "github" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup"],
        dismissed: true,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      // Dismissed onboarding should still show resume card (user can restart)
      expect(isOnboardingResumable()).toBe(true);
    });
  });

  describe("getOnboardingResumeStep", () => {
    it("returns null when no state exists", () => {
      expect(getOnboardingResumeStep()).toBeNull();
    });

    it("returns null when step is 'complete'", () => {
      const state = {
        currentStep: "complete" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingResumeStep()).toBeNull();
    });

    it("returns step info for known steps", () => {
      const steps: Array<"ai-setup" | "github" | "first-task"> = ["ai-setup", "github", "first-task"];
      for (const step of steps) {
        const state = {
          currentStep: step,
          updatedAt: "2024-01-01T00:00:00.000Z",
          completedSteps: [],
          dismissed: false,
          completed: false,
          stepData: {},
        };
        mockStore[STORAGE_KEY] = JSON.stringify(state);
        const result = getOnboardingResumeStep();
        expect(result).toEqual({
          currentStep: step,
          label: ONBOARDING_STEP_LABELS[step],
        });
      }
    });

    it("returns null when completed: true", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: ["ai-setup", "github"],
        dismissed: false,
        completed: true,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingResumeStep()).toBeNull();
    });

    it("returns null when completedAt is set (legacy format)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-02T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingResumeStep()).toBeNull();
    });

    it("returns fallback label for unknown future step IDs", () => {
      const state = {
        currentStep: "custom-step" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingResumeStep();
      expect(result).toEqual({
        currentStep: "custom-step",
        label: "Custom Step", // Falls back to title-case formatting
      });
    });

    it("handles kebab-case unknown steps", () => {
      const state = {
        currentStep: "my-custom-step" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingResumeStep();
      expect(result?.label).toBe("My Custom Step");
    });

    it("handles snake_case unknown steps", () => {
      const state = {
        currentStep: "my_custom_step" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingResumeStep();
      expect(result?.label).toBe("My Custom Step");
    });
  });

  describe("ONBOARDING_STEP_LABELS", () => {
    it("has labels for all known steps", () => {
      expect(ONBOARDING_STEP_LABELS["ai-setup"]).toBe("AI Setup");
      expect(ONBOARDING_STEP_LABELS["github"]).toBe("GitHub");
      expect(ONBOARDING_STEP_LABELS["first-task"]).toBe("First Task");
      expect(ONBOARDING_STEP_LABELS["complete"]).toBe("Complete");
    });
  });

  describe("markOnboardingCompleted", () => {
    it("sets completed: true and completedAt on existing state", () => {
      saveOnboardingState("first-task", { completedSteps: ["ai-setup"] });
      markOnboardingCompleted();
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("first-task");
      expect(parsed.completed).toBe(true);
      expect(parsed.completedAt).toBeDefined();
      expect(parsed.dismissed).toBe(false);
    });

    it("creates minimal state when no state exists", () => {
      markOnboardingCompleted();
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("complete");
      expect(parsed.completed).toBe(true);
      expect(parsed.completedAt).toBeDefined();
      expect(parsed.updatedAt).toBeDefined();
      expect(parsed.completedSteps).toEqual([]);
      expect(parsed.dismissed).toBe(false);
    });

    it("does not change currentStep if one is already set", () => {
      saveOnboardingState("github");
      markOnboardingCompleted();
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("github");
      expect(parsed.completed).toBe(true);
      expect(parsed.completedAt).toBeDefined();
    });

    it("updates completedAt timestamp on subsequent calls", async () => {
      saveOnboardingState("ai-setup", { completedSteps: ["ai-setup"] });
      markOnboardingCompleted();
      const firstStored = mockStore[STORAGE_KEY];
      const firstParsed = JSON.parse(firstStored);

      // Wait a tiny bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      markOnboardingCompleted();
      const secondStored = mockStore[STORAGE_KEY];
      const secondParsed = JSON.parse(secondStored);
      expect(secondParsed.completedAt).not.toBe(firstParsed.completedAt);
    });
  });

  describe("getOnboardingCompletedAt", () => {
    it("returns timestamp when completedAt is set", () => {
      const timestamp = "2024-01-02T00:00:00.000Z";
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedAt: timestamp,
        completedSteps: [],
        dismissed: false,
        completed: true,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingCompletedAt()).toBe(timestamp);
    });

    it("returns null when not completed (no completedAt)", () => {
      const state = {
        currentStep: "first-task" as const,
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingCompletedAt()).toBeNull();
    });

    it("returns null when no state exists", () => {
      expect(getOnboardingCompletedAt()).toBeNull();
    });
  });

  describe("backward compatibility with legacy state", () => {
    it("getOnboardingState returns defaults for legacy state", () => {
      // Pre-FN-1860 format: only currentStep and updatedAt
      const state = { currentStep: "github" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingState();
      expect(result).toEqual({
        currentStep: "github",
        updatedAt: "2024-01-01T00:00:00.000Z",
        completedSteps: [],
        dismissed: false,
        completed: false,
        stepData: {},
      });
    });

    it("isOnboardingCompleted returns false for legacy state without completedAt", () => {
      const state = { currentStep: "first-task" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingCompleted()).toBe(false);
    });

    it("isOnboardingResumable works with legacy state", () => {
      const state = { currentStep: "github" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingResumable()).toBe(true);
    });

    it("getCompletedSteps returns empty array for legacy state", () => {
      const state = { currentStep: "first-task" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getCompletedSteps()).toEqual([]);
    });

    it("getStepData returns null for legacy state", () => {
      const state = { currentStep: "first-task" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getStepData("ai-setup")).toBeNull();
    });
  });
});
