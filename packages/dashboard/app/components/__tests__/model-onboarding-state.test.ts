import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getOnboardingState,
  saveOnboardingState,
  clearOnboardingState,
  isOnboardingResumable,
  getOnboardingResumeStep,
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

    it("returns parsed state for valid data", () => {
      const state = { currentStep: "ai-setup" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingState()).toEqual(state);
    });

    it("returns parsed state for unknown step IDs", () => {
      const state = { currentStep: "unknown-step", updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      // Unknown steps are now accepted (fallback label logic handles them)
      expect(getOnboardingState()).toEqual(state);
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
  });

  describe("saveOnboardingState", () => {
    it("persists state to localStorage", () => {
      saveOnboardingState("ai-setup");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("ai-setup");
      expect(parsed.updatedAt).toBeDefined();
    });

    it("overwrites existing state", () => {
      saveOnboardingState("github");
      saveOnboardingState("first-task");
      const stored = mockStore[STORAGE_KEY];
      const parsed = JSON.parse(stored);
      expect(parsed.currentStep).toBe("first-task");
    });
  });

  describe("clearOnboardingState", () => {
    it("removes state from localStorage", () => {
      const state = { currentStep: "ai-setup" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      clearOnboardingState();
      expect(mockStore[STORAGE_KEY]).toBeUndefined();
    });
  });

  describe("isOnboardingResumable", () => {
    it("returns false when no state exists", () => {
      expect(isOnboardingResumable()).toBe(false);
    });

    it("returns false when step is 'complete'", () => {
      const state = { currentStep: "complete" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(isOnboardingResumable()).toBe(false);
    });

    it("returns true for non-terminal steps", () => {
      const steps: Array<"ai-setup" | "github" | "first-task"> = ["ai-setup", "github", "first-task"];
      for (const step of steps) {
        const state = { currentStep: step, updatedAt: "2024-01-01T00:00:00.000Z" };
        mockStore[STORAGE_KEY] = JSON.stringify(state);
        expect(isOnboardingResumable()).toBe(true);
      }
    });
  });

  describe("getOnboardingResumeStep", () => {
    it("returns null when no state exists", () => {
      expect(getOnboardingResumeStep()).toBeNull();
    });

    it("returns null when step is 'complete'", () => {
      const state = { currentStep: "complete" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      expect(getOnboardingResumeStep()).toBeNull();
    });

    it("returns step info for known steps", () => {
      const steps: Array<"ai-setup" | "github" | "first-task"> = ["ai-setup", "github", "first-task"];
      for (const step of steps) {
        const state = { currentStep: step, updatedAt: "2024-01-01T00:00:00.000Z" };
        mockStore[STORAGE_KEY] = JSON.stringify(state);
        const result = getOnboardingResumeStep();
        expect(result).toEqual({
          currentStep: step,
          label: ONBOARDING_STEP_LABELS[step],
        });
      }
    });

    it("returns fallback label for unknown future step IDs", () => {
      const state = { currentStep: "custom-step" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingResumeStep();
      expect(result).toEqual({
        currentStep: "custom-step",
        label: "Custom Step", // Falls back to title-case formatting
      });
    });

    it("handles kebab-case unknown steps", () => {
      const state = { currentStep: "my-custom-step" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
      mockStore[STORAGE_KEY] = JSON.stringify(state);
      const result = getOnboardingResumeStep();
      expect(result?.label).toBe("My Custom Step");
    });

    it("handles snake_case unknown steps", () => {
      const state = { currentStep: "my_custom_step" as const, updatedAt: "2024-01-01T00:00:00.000Z" };
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
});
