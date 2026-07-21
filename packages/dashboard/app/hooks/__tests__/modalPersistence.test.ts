import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("modalPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
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
