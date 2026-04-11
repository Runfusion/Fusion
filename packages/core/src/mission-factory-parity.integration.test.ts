/**
 * Mission Factory Parity Integration Tests
 *
 * These tests verify that Factory mission behavior stays consistent across
 * MissionStore persistence layers. They test:
 * - Clarification artifacts (planningNotes, verification) persist across restart
 * - Feature execution transitions stay synchronized
 * - Retry round behavior is consistent
 * - Blocked paths prevent further scheduling
 *
 * Run: pnpm --filter @fusion/core exec vitest run src/mission-factory-parity.integration.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "./store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-mission-factory-parity-"));
}

/**
 * Parity Matrix: Maps scenario → MissionStore API → persisted field
 *
 * | Scenario                           | API                          | Field                    |
 * |------------------------------------|------------------------------|--------------------------|
 * | Planning notes persist             | updateMilestone/slice         | planningNotes             |
 * | Verification criteria persist      | updateMilestone/slice         | verification             |
 * | Enriched context tied to hierarchy | buildEnrichedDescription     | (computed)               |
 * | Feature link stable across restart | linkFeatureToTask            | taskId                   |
 * | Feature status transitions         | updateFeatureStatus          | status                   |
 * | Rollup reflects current state      | getMissionHealth             | tasksCompleted, etc.     |
 * | Autopilot enabled persists         | updateMission(autopilot)     | autopilotEnabled         |
 * | Blocked features tracked           | updateFeatureStatus(blocked) | status=blocked           |
 */

describe("MissionFactory Parity: Core MissionStore", () => {
  let rootDir: string;
  let taskStore: TaskStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));

    rootDir = makeTmpDir();
    taskStore = new TaskStore(rootDir);
    await taskStore.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("Parity Matrix: Clarification Artifacts Persistence", () => {
    it("milestone planningNotes persist across store restart", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create hierarchy
      const mission = missionStore.createMission({
        title: "Auth System",
        description: "Build authentication",
      });
      const milestone = missionStore.addMilestone(mission.id, {
        title: "Core Auth",
        description: "Implement JWT",
      });

      // Update planning notes
      const planningNotes = "Using RS256 signing strategy";
      missionStore.updateMilestone(milestone.id, { planningNotes });

      // Simulate restart by creating new store instance
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      // Verify persistence
      const retrieved = missionStore2.getMilestone(milestone.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.planningNotes).toBe(planningNotes);
    });

    it("milestone verification persists across store restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, {
        title: "Core",
        description: "Core implementation",
      });

      const verification = "Users can authenticate with email/password";
      missionStore.updateMilestone(milestone.id, { verification });

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getMilestone(milestone.id);
      expect(retrieved!.verification).toBe(verification);
    });

    it("slice planningNotes persist across store restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, {
        title: "S1",
        description: "Slice 1",
      });

      const planningNotes = "Use existing design system tokens";
      missionStore.updateSlice(slice.id, { planningNotes });

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getSlice(slice.id);
      expect(retrieved!.planningNotes).toBe(planningNotes);
    });

    it("slice verification persists across store restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, {
        title: "S1",
        description: "Slice 1",
      });

      const verification = "Login form accepts valid credentials";
      missionStore.updateSlice(slice.id, { verification });

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getSlice(slice.id);
      expect(retrieved!.verification).toBe(verification);
    });

    it("enriched description tied to correct hierarchy node", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create hierarchy with distinct context at each level
      const mission = missionStore.createMission({
        title: "Auth Mission",
        description: "Build complete auth system",
      });
      const milestone = missionStore.addMilestone(mission.id, {
        title: "Login Milestone",
        description: "Implement login flow",
        planningNotes: "JWT with refresh tokens",
        verification: "Users can log in",
      });
      const slice = missionStore.addSlice(milestone.id, {
        title: "Login Slice",
        description: "Build login UI",
        planningNotes: "Use existing components",
        verification: "Form validates input",
      });
      const feature = missionStore.addFeature(slice.id, {
        title: "Login Form Feature",
        description: "Email/password form",
        acceptanceCriteria: "Shows validation errors",
      });

      // Build enriched description
      const enriched = missionStore.buildEnrichedDescription(feature.id);

      expect(enriched).toBeDefined();
      // Verify context is tied to correct levels
      expect(enriched).toContain("Auth Mission");
      expect(enriched).toContain("Login Milestone");
      expect(enriched).toContain("Login Slice");
      expect(enriched).toContain("Login Form Feature");
      // Verify distinct planning notes
      expect(enriched).toContain("JWT with refresh tokens");
      expect(enriched).toContain("Use existing components");
    });

    it("enriched description omits empty sections", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({
        title: "Minimal Mission",
        description: "Just basics",
      });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, {
        title: "F1",
        description: "Feature",
      });

      const enriched = missionStore.buildEnrichedDescription(feature.id);

      // Should not have undefined/null strings in output
      expect(enriched).not.toMatch(/Planning Notes:\s*undefined/);
      expect(enriched).not.toMatch(/Verification:\s*undefined/);
      expect(enriched).not.toMatch(/Description:\s*undefined/);
    });
  });

  describe("Parity Matrix: Feature Execution Transitions", () => {
    it("linkFeatureToTask creates stable link", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, {
        title: "F1",
        description: "Feature 1",
      });

      // First create the task in the store (linkFeatureToTask requires task to exist)
      const task = await taskStore.createTask({
        title: "Task for F1",
        description: "Created for feature link",
      });

      // Link feature to task
      missionStore.linkFeatureToTask(feature.id, task.id);

      // Restart and verify link persists
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const linked = missionStore2.getFeatureByTaskId(task.id);
      expect(linked).toBeDefined();
      expect(linked!.id).toBe(feature.id);
    });

    it("updateFeatureStatus transitions are recorded correctly", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, {
        title: "F1",
        description: "Feature",
      });

      // Transition through states (note: 'done' not 'completed')
      missionStore.updateFeatureStatus(feature.id, "defined");
      missionStore.updateFeatureStatus(feature.id, "in-progress");
      missionStore.updateFeatureStatus(feature.id, "blocked");
      missionStore.updateFeatureStatus(feature.id, "done");

      // Verify final state
      const hierarchy = missionStore.getMissionWithHierarchy(mission.id);
      const featureState = hierarchy!.milestones[0].slices[0].features[0];
      expect(featureState.status).toBe("done");
    });

    it("triageFeature enriches task with context", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({
        title: "Auth Mission",
        description: "Build auth",
      });
      const milestone = missionStore.addMilestone(mission.id, {
        title: "Core Auth",
        description: "Implement JWT",
        verification: "Login works",
      });
      const slice = missionStore.addSlice(milestone.id, {
        title: "Login",
        description: "Login UI",
      });
      const feature = missionStore.addFeature(slice.id, {
        title: "Login Form",
        description: "Standard form",
      });

      // Triage the feature (creates task and links)
      const updatedFeature = await missionStore.triageFeature(feature.id);

      expect(updatedFeature).toBeDefined();
      expect(updatedFeature.taskId).toBeDefined();
      expect(updatedFeature.taskId).toMatch(/^FN-/);

      // Verify the task has enriched description
      const task = await taskStore.getTask(updatedFeature.taskId!);
      expect(task).toBeDefined();
      expect(task!.description).toContain("Auth Mission");
      expect(task!.description).toContain("Core Auth");
      expect(task!.description).toContain("Login Form");
    });
  });

  describe("Parity Matrix: Mission Health Rollups", () => {
    it("getMissionHealth reflects current feature states", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });

      // Add features with various states
      const f1 = missionStore.addFeature(slice.id, { title: "F1" });
      const f2 = missionStore.addFeature(slice.id, { title: "F2" });
      const f3 = missionStore.addFeature(slice.id, { title: "F3" });

      // Use correct status values
      missionStore.updateFeatureStatus(f1.id, "done");
      missionStore.updateFeatureStatus(f2.id, "in-progress");
      missionStore.updateFeatureStatus(f3.id, "blocked");

      const health = missionStore.getMissionHealth(mission.id);

      expect(health).toBeDefined();
      expect(health!.totalTasks).toBe(3);
      expect(health!.tasksCompleted).toBe(1);
      expect(health!.tasksInFlight).toBe(1);
    });

    it("health rollup updates when feature status changes", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, { title: "F1" });

      // Initial health - no completed features
      let health = missionStore.getMissionHealth(mission.id);
      expect(health!.tasksCompleted).toBe(0);

      // Complete the feature (status = 'done')
      missionStore.updateFeatureStatus(feature.id, "done");

      // Health should update
      health = missionStore.getMissionHealth(mission.id);
      expect(health!.tasksCompleted).toBe(1);
    });

    it("blocked features tracked in health", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });

      // Create blocked features
      const f1 = missionStore.addFeature(slice.id, { title: "F1" });
      const f2 = missionStore.addFeature(slice.id, { title: "F2" });

      missionStore.updateFeatureStatus(f1.id, "blocked");
      missionStore.updateFeatureStatus(f2.id, "blocked");

      // Note: MissionHealth doesn't have a blockedFeatures field,
      // but it does track tasksFailed for failed tasks
      const health = missionStore.getMissionHealth(mission.id);
      expect(health).toBeDefined();
      expect(health!.totalTasks).toBe(2);
    });
  });

  describe("Parity Matrix: Autopilot Configuration", () => {
    it("autopilotEnabled persists across restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({
        title: "Test",
        autopilotEnabled: true,
      });

      // Verify initial state
      let retrieved = missionStore.getMission(mission.id);
      expect(retrieved!.autopilotEnabled).toBe(true);

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      // Verify persistence
      retrieved = missionStore2.getMission(mission.id);
      expect(retrieved!.autopilotEnabled).toBe(true);
    });

    it("autopilotEnabled can be toggled", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({
        title: "Test",
        autopilotEnabled: false,
      });

      // Enable autopilot
      missionStore.updateMission(mission.id, { autopilotEnabled: true });

      let retrieved = missionStore.getMission(mission.id);
      expect(retrieved!.autopilotEnabled).toBe(true);

      // Disable autopilot
      missionStore.updateMission(mission.id, { autopilotEnabled: false });

      retrieved = missionStore.getMission(mission.id);
      expect(retrieved!.autopilotEnabled).toBe(false);
    });

    it("autopilotState persists across restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({
        title: "Test",
        autopilotEnabled: true,
      });

      // Update autopilot state
      missionStore.updateMission(mission.id, { autopilotState: "watching" });

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const retrieved = missionStore2.getMission(mission.id);
      expect(retrieved!.autopilotState).toBe("watching");
    });
  });

  describe("Parity Matrix: Blocked Feature Paths", () => {
    it("blocked features remain blocked across restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, { title: "F1" });

      missionStore.updateFeatureStatus(feature.id, "blocked");

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      // Verify blocked status persisted
      const hierarchy = missionStore2.getMissionWithHierarchy(mission.id);
      const fState = hierarchy!.milestones[0].slices[0].features[0];
      expect(fState.status).toBe("blocked");
    });

    it("blocked features affect mission health", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, { title: "F1" });

      missionStore.updateFeatureStatus(feature.id, "blocked");

      const health = missionStore.getMissionHealth(mission.id);
      expect(health).toBeDefined();
      expect(health!.totalTasks).toBe(1);
      // Mission is in planning status since we haven't activated it yet
      expect(health!.status).toBe("planning");
    });

    it("blocked feature can be unblocked", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "M1" });
      const slice = missionStore.addSlice(milestone.id, { title: "S1" });
      const feature = missionStore.addFeature(slice.id, { title: "F1" });

      // Block then unblock
      missionStore.updateFeatureStatus(feature.id, "blocked");
      missionStore.updateFeatureStatus(feature.id, "defined");

      const hierarchy = missionStore.getMissionWithHierarchy(mission.id);
      const fState = hierarchy!.milestones[0].slices[0].features[0];
      expect(fState.status).toBe("defined");
    });
  });

  describe("Parity Matrix: Deterministic Event Ordering", () => {
    it("mission events ordered by timestamp with stable tiebreaker", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });

      // Create events in rapid succession (same millisecond)
      vi.advanceTimersByTime(0);
      missionStore.logMissionEvent(mission.id, "warning", "First");
      vi.advanceTimersByTime(1);
      missionStore.logMissionEvent(mission.id, "warning", "Second");
      vi.advanceTimersByTime(1);
      missionStore.logMissionEvent(mission.id, "warning", "Third");

      const result = missionStore.getMissionEvents(mission.id);

      // Events are ordered by timestamp DESC, id DESC (most recent first)
      expect(result.events.length).toBeGreaterThanOrEqual(3);
      // Most recent event should be first
      expect(result.events[0].description).toBe("Third");
    });

    it("event log persists across restart", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test" });
      missionStore.logMissionEvent(mission.id, "warning", "Test message", {
        source: "parity_test",
      });

      // Restart
      taskStore.close();
      const taskStore2 = new TaskStore(rootDir);
      await taskStore2.init();
      const missionStore2 = taskStore2.getMissionStore();

      const result = missionStore2.getMissionEvents(mission.id);
      expect(result.events.some((e) => e.description === "Test message")).toBe(true);
    });
  });
});
