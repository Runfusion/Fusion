import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  STORED_PLANNING_KEY,
  STORED_SUBTASK_KEY,
  STORED_MISSION_KEY,
  savePlanningDescription,
  getPlanningDescription,
  clearPlanningDescription,
  saveSubtaskDescription,
  getSubtaskDescription,
  clearSubtaskDescription,
  saveMissionGoal,
  getMissionGoal,
  clearMissionGoal,
} from "../modalPersistence";

describe("modalPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("Storage keys are exported", () => {
    it("exports planning key", () => {
      expect(STORED_PLANNING_KEY).toBe("kb-planning-last-description");
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

    it("returns empty string when nothing saved", () => {
      expect(getPlanningDescription()).toBe("");
    });

    it("clears correctly", () => {
      savePlanningDescription("Test");
      clearPlanningDescription();
      expect(getPlanningDescription()).toBe("");
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

  describe("Subtask persistence", () => {
    it("saves and retrieves subtask description", () => {
      saveSubtaskDescription("Implement login feature");
      expect(getSubtaskDescription()).toBe("Implement login feature");
    });

    it("returns empty string when nothing saved", () => {
      expect(getSubtaskDescription()).toBe("");
    });

    it("clears correctly", () => {
      saveSubtaskDescription("Test");
      clearSubtaskDescription();
      expect(getSubtaskDescription()).toBe("");
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

    it("returns empty string when nothing saved", () => {
      expect(getMissionGoal()).toBe("");
    });

    it("clears correctly", () => {
      saveMissionGoal("Test");
      clearMissionGoal();
      expect(getMissionGoal()).toBe("");
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
  });
});
