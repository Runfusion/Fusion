import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { PlanningModeModal, resetPlanningAutoRetryAttemptsForTests } from "../../components/PlanningModeModal";
import {
  mockCreatePlanningDraft,
  mockFetchAiSessions,
  mockStartPlanningStreaming,
  mockTasks,
} from "../../components/__tests__/PlanningModeModal.test-helpers";
import {
  STORED_PLANNING_KEY,
  STORED_PLANNING_ACTIVE_SESSION_KEY,
  STORED_SUBTASK_KEY,
  STORED_MISSION_KEY,
  savePlanningDescription,
  getPlanningDescription,
  clearPlanningDescription,
  savePlanningActiveSession,
  getPlanningActiveSession,
  clearPlanningActiveSession,
  saveSubtaskDescription,
  getSubtaskDescription,
  clearSubtaskDescription,
  saveMissionGoal,
  getMissionGoal,
  clearMissionGoal,
} from "../modalPersistence";
import { scopedKey } from "../../utils/projectStorage";

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", isTabletTouchViewport: (mode?: string) => mode === "tablet", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: fn(), fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    respondToPlanning: fn(), validatePlanningSession: fn(), createTaskFromPlanning: fn(),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }), fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]), fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: (...args: unknown[]) => mockStartPlanningStreaming(...args), createPlanningDraft: (...args: unknown[]) => mockCreatePlanningDraft(...args), connectPlanningStream: fn(), rewindPlanningSession: fn(), retryPlanningSession: fn().mockResolvedValue({ success: true }), cancelPlanning: fn(), stopPlanningGeneration: fn(), updatePlanningSessionDraft: fn(), updatePlanningSessionTitle: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(), parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"), acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(), uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(), fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(), deleteAiSession: fn(), refineText: fn(), getRefineErrorMessage: (error: Error) => error.message,
  };
});

describe("modalPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockViewportMode.mockReturnValue("desktop");
    mockFetchAiSessions.mockResolvedValue([]);
    mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-1", title: "Resilient plan" });
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "draft-1" });
  });

  afterEach(() => {
    cleanup();
    resetPlanningAutoRetryAttemptsForTests();
    vi.restoreAllMocks();
  });

  describe("Storage keys are exported", () => {
    it("exports planning key", () => {
      expect(STORED_PLANNING_KEY).toBe("kb-planning-last-description");
    });

    it("exports planning active-session key", () => {
      expect(STORED_PLANNING_ACTIVE_SESSION_KEY).toBe("kb-planning-active-session");
    });

    it("exports subtask key", () => {
      expect(STORED_SUBTASK_KEY).toBe("kb-subtask-last-description");
    });

    it("exports mission key", () => {
      expect(STORED_MISSION_KEY).toBe("kb-mission-last-goal");
    });
  });

  describe("Planning persistence", () => {
    it("saves and retrieves planning description", () => {
      savePlanningDescription("Build authentication");
      expect(getPlanningDescription()).toBe("Build authentication");
    });

    it("saves and retrieves planning description per project", () => {
      savePlanningDescription("Build auth for project", "proj-123");
      expect(getPlanningDescription("proj-123")).toBe("Build auth for project");
      expect(localStorage.getItem(scopedKey(STORED_PLANNING_KEY, "proj-123"))).toBe(
        "Build auth for project",
      );
    });

    it("returns empty string when nothing saved", () => {
      expect(getPlanningDescription()).toBe("");
    });

    it("clears correctly", () => {
      savePlanningDescription("Test");
      clearPlanningDescription();
      expect(getPlanningDescription()).toBe("");
    });

    it("clears correctly per project", () => {
      savePlanningDescription("Test", "proj-123");
      clearPlanningDescription("proj-123");
      expect(getPlanningDescription("proj-123")).toBe("");
    });

    it("returns empty string when localStorage returns null", () => {
      vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
      expect(getPlanningDescription()).toBe("");
      vi.restoreAllMocks();
    });

    it("overwrites previous value", () => {
      savePlanningDescription("First");
      savePlanningDescription("Second");
      expect(getPlanningDescription()).toBe("Second");
    });
  });

  describe("Planning active-session persistence", () => {
    it("saves, reads, and clears an active session per project", () => {
      savePlanningActiveSession("planning-123", "proj-123");
      expect(getPlanningActiveSession("proj-123")).toBe("planning-123");
      expect(getPlanningActiveSession("proj-other")).toBe("");
      clearPlanningActiveSession("proj-123");
      expect(getPlanningActiveSession("proj-123")).toBe("");
    });
  });

  describe("Planning write recovery", () => {
    it("uses the first successful write without eviction", () => {
      const setItem = vi.spyOn(localStorage, "setItem");
      const removeItem = vi.spyOn(localStorage, "removeItem");

      expect(() => savePlanningActiveSession("session-1", "project-a")).not.toThrow();

      expect(setItem).toHaveBeenCalledTimes(1);
      expect(removeItem).not.toHaveBeenCalled();
    });

    it("evicts only the failed description key and retries once", () => {
      const planningKey = scopedKey(STORED_PLANNING_KEY, "project-a");
      const otherProjectKey = scopedKey(STORED_PLANNING_KEY, "project-b");
      localStorage.setItem(planningKey, "old description");
      localStorage.setItem(otherProjectKey, "other project");
      localStorage.setItem("unrelated-key", "preserved");
      const originalSetItem = localStorage.setItem;
      const setItem = vi.spyOn(localStorage, "setItem")
        .mockImplementationOnce(() => { throw new DOMException("Quota exceeded"); })
        .mockImplementation(function (key: string, value: string) {
          originalSetItem.call(this, key, value);
        });
      const removeItem = vi.spyOn(localStorage, "removeItem");

      expect(() => savePlanningDescription("new description", "project-a")).not.toThrow();

      expect(setItem).toHaveBeenCalledTimes(2);
      expect(removeItem).toHaveBeenCalledTimes(1);
      expect(removeItem).toHaveBeenCalledWith(planningKey);
      expect(localStorage.getItem(planningKey)).toBe("new description");
      expect(localStorage.getItem(otherProjectKey)).toBe("other project");
      expect(localStorage.getItem("unrelated-key")).toBe("preserved");
    });

    it.each([
      ["description", STORED_PLANNING_KEY, savePlanningDescription, "new description"],
      ["active session", STORED_PLANNING_ACTIVE_SESSION_KEY, savePlanningActiveSession, "session-2"],
    ] as const)("swallows persistent %s write failures after one retry", (_name, baseKey, save, value) => {
      const planningKey = scopedKey(baseKey, "project-a");
      localStorage.setItem(planningKey, "old value");
      localStorage.setItem("unrelated-key", "preserved");
      const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded");
      });
      const removeItem = vi.spyOn(localStorage, "removeItem");

      expect(() => save(value, "project-a")).not.toThrow();

      expect(setItem).toHaveBeenCalledTimes(2);
      expect(removeItem).toHaveBeenCalledTimes(1);
      expect(removeItem).toHaveBeenCalledWith(planningKey);
      expect(localStorage.getItem("unrelated-key")).toBe("preserved");
    });

    it("swallows cleanup failure and respects unavailable storage methods", () => {
      const planningKey = scopedKey(STORED_PLANNING_KEY, "project-a");
      const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded");
      });
      const removeItem = vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
        throw new DOMException("Storage disabled");
      });

      expect(() => savePlanningDescription("new description", "project-a")).not.toThrow();
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(removeItem).toHaveBeenCalledWith(planningKey);

      vi.restoreAllMocks();
      const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", { configurable: true, value: {} });
      try {
        expect(() => savePlanningDescription("ignored", "project-a")).not.toThrow();
      } finally {
        Object.defineProperty(window, "localStorage", descriptor!);
      }
    });
  });

  describe("PlanningModeModal storage failure regression", () => {
    it("continues draft creation and streaming through persistent scoped storage failures", async () => {
      const descriptionKey = scopedKey(STORED_PLANNING_KEY, "project-1");
      const activeSessionKey = scopedKey(STORED_PLANNING_ACTIVE_SESSION_KEY, "project-1");
      localStorage.setItem(descriptionKey, "old draft");
      localStorage.setItem("kb:project-2:kb-planning-last-description", "other project");
      localStorage.setItem("unrelated-key", "preserved");

      render(createElement(PlanningModeModal, {
        isOpen: true,
        onClose: vi.fn(),
        onTaskCreated: vi.fn(),
        onTasksCreated: vi.fn(),
        tasks: mockTasks,
        projectId: "project-1",
      }));
      localStorage.setItem(activeSessionKey, "old session");
      const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded");
      });
      const removeItem = vi.spyOn(localStorage, "removeItem");

      fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "Build resilient planning" } });
      fireEvent.click(screen.getByRole("button", { name: "Start Planning" }));

      await waitFor(() => expect(mockCreatePlanningDraft).toHaveBeenCalledWith("Build resilient planning", "project-1", undefined));
      await waitFor(() => expect(mockStartPlanningStreaming).toHaveBeenCalledWith("Build resilient planning", "project-1", undefined, { clarificationEnabled: true }, "draft-1"));

      expect(removeItem).toHaveBeenCalledWith(descriptionKey);
      expect(removeItem).toHaveBeenCalledWith(activeSessionKey);
      expect(setItem.mock.calls.filter(([key]) => key === descriptionKey)).toHaveLength(2);
      // The durable draft hand-off and the selected-session effect each retry their same active key once.
      expect(setItem.mock.calls.filter(([key]) => key === activeSessionKey)).toHaveLength(4);
      expect(setItem).toHaveBeenCalledTimes(6);
      expect(localStorage.getItem("kb:project-2:kb-planning-last-description")).toBe("other project");
      expect(localStorage.getItem("unrelated-key")).toBe("preserved");
      expect(screen.queryByText("Quota exceeded")).toBeNull();
    });
  });

  describe("Subtask persistence", () => {
    it("saves and retrieves subtask description", () => {
      saveSubtaskDescription("Implement login feature");
      expect(getSubtaskDescription()).toBe("Implement login feature");
    });

    it("saves and retrieves subtask description per project", () => {
      saveSubtaskDescription("Implement login feature", "proj-123");
      expect(getSubtaskDescription("proj-123")).toBe("Implement login feature");
      expect(localStorage.getItem(scopedKey(STORED_SUBTASK_KEY, "proj-123"))).toBe(
        "Implement login feature",
      );
    });

    it("returns empty string when nothing saved", () => {
      expect(getSubtaskDescription()).toBe("");
    });

    it("clears correctly", () => {
      saveSubtaskDescription("Test");
      clearSubtaskDescription();
      expect(getSubtaskDescription()).toBe("");
    });

    it("clears correctly per project", () => {
      saveSubtaskDescription("Test", "proj-123");
      clearSubtaskDescription("proj-123");
      expect(getSubtaskDescription("proj-123")).toBe("");
    });

    it("overwrites previous value", () => {
      saveSubtaskDescription("First");
      saveSubtaskDescription("Second");
      expect(getSubtaskDescription()).toBe("Second");
    });
  });

  describe("Mission persistence", () => {
    it("saves and retrieves mission goal", () => {
      saveMissionGoal("Build a SaaS platform");
      expect(getMissionGoal()).toBe("Build a SaaS platform");
    });

    it("saves and retrieves mission goal per project", () => {
      saveMissionGoal("Build a SaaS platform", "proj-123");
      expect(getMissionGoal("proj-123")).toBe("Build a SaaS platform");
      expect(localStorage.getItem(scopedKey(STORED_MISSION_KEY, "proj-123"))).toBe(
        "Build a SaaS platform",
      );
    });

    it("returns empty string when nothing saved", () => {
      expect(getMissionGoal()).toBe("");
    });

    it("clears correctly", () => {
      saveMissionGoal("Test");
      clearMissionGoal();
      expect(getMissionGoal()).toBe("");
    });

    it("clears correctly per project", () => {
      saveMissionGoal("Test", "proj-123");
      clearMissionGoal("proj-123");
      expect(getMissionGoal("proj-123")).toBe("");
    });

    it("overwrites previous value", () => {
      saveMissionGoal("First");
      saveMissionGoal("Second");
      expect(getMissionGoal()).toBe("Second");
    });
  });

  describe("Storage keys are independent", () => {
    it("planning and subtask do not interfere", () => {
      savePlanningDescription("planning desc");
      saveSubtaskDescription("subtask desc");
      expect(getPlanningDescription()).toBe("planning desc");
      expect(getSubtaskDescription()).toBe("subtask desc");
    });

    it("planning and mission do not interfere", () => {
      savePlanningDescription("planning desc");
      saveMissionGoal("mission goal");
      expect(getPlanningDescription()).toBe("planning desc");
      expect(getMissionGoal()).toBe("mission goal");
    });

    it("subtask and mission do not interfere", () => {
      saveSubtaskDescription("subtask desc");
      saveMissionGoal("mission goal");
      expect(getSubtaskDescription()).toBe("subtask desc");
      expect(getMissionGoal()).toBe("mission goal");
    });

    it("clearing one does not affect others", () => {
      savePlanningDescription("planning");
      saveSubtaskDescription("subtask");
      saveMissionGoal("mission");

      clearSubtaskDescription();
      expect(getPlanningDescription()).toBe("planning");
      expect(getSubtaskDescription()).toBe("");
      expect(getMissionGoal()).toBe("mission");
    });

    it("project-scoped values do not interfere with other projects", () => {
      savePlanningDescription("project-a", "proj-a");
      savePlanningDescription("project-b", "proj-b");

      expect(getPlanningDescription("proj-a")).toBe("project-a");
      expect(getPlanningDescription("proj-b")).toBe("project-b");
      expect(getPlanningDescription()).toBe("");
    });
  });
});
