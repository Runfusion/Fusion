import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "./store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-mission-planning-"));
}

/**
 * MissionStore planning context integration tests verify the enriched triage flow
 * that adds mission hierarchy context to task descriptions. These scenarios cover:
 * - Full hierarchy context enrichment in task descriptions
 * - Omission of empty hierarchy sections
 * - Custom description override bypassing enrichment
 * - Bulk triage with enrichment
 * - Enrichment after interview updates
 * - Plan state transitions
 */
describe("MissionStore planning context integration", () => {
  let rootDir: string;
  let taskStore: TaskStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));

    rootDir = makeTmpDir();
    taskStore = new TaskStore(rootDir);
    await taskStore.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("buildEnrichedDescription", () => {
    it("enriches task description with full hierarchy context", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create full hierarchy with rich context
      const mission = missionStore.createMission({
        title: "Launch Authentication",
        description: "Build a complete auth system",
      });

      const milestone = missionStore.addMilestone(mission.id, {
        title: "Core Auth",
        description: "Implement core authentication",
        verification: "Users can log in and log out",
        planningNotes: "Decided on JWT strategy",
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "Login Page",
        description: "Build the login UI",
        verification: "Login form accepts valid credentials",
        planningNotes: "Use existing design system",
      });

      const feature = missionStore.addFeature(slice.id, {
        title: "Login Form",
        description: "Standard login form with email/password",
        acceptanceCriteria: "Form validates input and shows errors",
      });

      // Build enriched description
      const enriched = missionStore.buildEnrichedDescription(feature.id);

      expect(enriched).toBeDefined();
      // Mission context
      expect(enriched).toContain("Launch Authentication");
      expect(enriched).toContain("Build a complete auth system");
      // Milestone context
      expect(enriched).toContain("Core Auth");
      expect(enriched).toContain("Implement core authentication");
      expect(enriched).toContain("Users can log in and log out");
      expect(enriched).toContain("Decided on JWT strategy");
      // Slice context
      expect(enriched).toContain("Login Page");
      expect(enriched).toContain("Build the login UI");
      expect(enriched).toContain("Login form accepts valid credentials");
      expect(enriched).toContain("Use existing design system");
      // Feature context
      expect(enriched).toContain("Login Form");
      expect(enriched).toContain("Standard login form with email/password");
      expect(enriched).toContain("Form validates input and shows errors");
    });

    it("omits empty hierarchy sections from enriched description", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create minimal hierarchy
      const mission = missionStore.createMission({
        title: "Minimal Mission",
        description: "Just a title and description",
      });

      const milestone = missionStore.addMilestone(mission.id, {
        title: "Minimal Milestone",
        // No description, verification, or planningNotes
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "Minimal Slice",
        // No description, verification, or planningNotes
      });

      const feature = missionStore.addFeature(slice.id, {
        title: "Minimal Feature",
        description: "Feature with description only",
        // No acceptance criteria
      });

      const enriched = missionStore.buildEnrichedDescription(feature.id);

      expect(enriched).toBeDefined();
      // Mission title should be present
      expect(enriched).toContain("Minimal Mission");
      expect(enriched).toContain("Just a title and description");
      // Milestone title should be present but description/verification/notes sections should not be empty
      expect(enriched).toContain("Minimal Milestone");
      // Should not have empty sections like "Description: undefined"
      expect(enriched).not.toMatch(/Description:\s*undefined/);
      expect(enriched).not.toMatch(/Verification:\s*undefined/);
      expect(enriched).not.toMatch(/Planning Notes:\s*undefined/);
      // Feature context
      expect(enriched).toContain("Minimal Feature");
      expect(enriched).toContain("Feature with description only");
    });

    it("returns undefined for non-existent feature", async () => {
      const missionStore = taskStore.getMissionStore();

      const enriched = missionStore.buildEnrichedDescription("non-existent-id");

      expect(enriched).toBeUndefined();
    });

    it("returns undefined when slice is not found", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Test Feature" });

      // Manually delete the slice to simulate orphan feature
      missionStore.deleteSlice(slice.id);

      const enriched = missionStore.buildEnrichedDescription(feature.id);

      expect(enriched).toBeUndefined();
    });
  });

  describe("triageFeature with enrichment", () => {
    it("triageFeature enriches task description with full hierarchy context", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create full hierarchy
      const mission = missionStore.createMission({
        title: "Authentication System",
        description: "Implement complete auth",
      });

      const milestone = missionStore.addMilestone(mission.id, {
        title: "User Management",
        description: "Handle user accounts",
        verification: "Users can manage accounts",
        planningNotes: "Use PostgreSQL for user data",
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "User Registration",
        description: "Build registration flow",
        verification: "Users can register",
        planningNotes: "Add email verification",
      });

      const feature = missionStore.addFeature(slice.id, {
        title: "Registration Form",
        description: "Create registration form",
        acceptanceCriteria: "Form submits successfully",
      });

      // Triage the feature (no custom description override)
      await missionStore.triageFeature(feature.id);

      // Get the linked task
      const updatedFeature = missionStore.getFeature(feature.id);
      expect(updatedFeature?.taskId).toBeDefined();

      const task = await taskStore.getTask(updatedFeature!.taskId!);
      expect(task.description).toContain("Authentication System");
      expect(task.description).toContain("Implement complete auth");
      expect(task.description).toContain("User Management");
      expect(task.description).toContain("Handle user accounts");
      expect(task.description).toContain("Users can manage accounts");
      expect(task.description).toContain("Use PostgreSQL for user data");
      expect(task.description).toContain("User Registration");
      expect(task.description).toContain("Build registration flow");
      expect(task.description).toContain("Users can register");
      expect(task.description).toContain("Add email verification");
      expect(task.description).toContain("Registration Form");
      expect(task.description).toContain("Create registration form");
      expect(task.description).toContain("Form submits successfully");
    });

    it("triageFeature with custom description override skips enrichment", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create full hierarchy
      const mission = missionStore.createMission({
        title: "Full Mission",
        description: "Full mission description",
      });

      const milestone = missionStore.addMilestone(mission.id, {
        title: "Full Milestone",
        description: "Full milestone description",
        verification: "Full verification",
        planningNotes: "Full notes",
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "Full Slice",
        description: "Full slice description",
        verification: "Full slice verification",
        planningNotes: "Full slice notes",
      });

      const feature = missionStore.addFeature(slice.id, {
        title: "Custom Feature",
        description: "Custom feature description",
      });

      // Triage with custom description override
      await missionStore.triageFeature(
        feature.id,
        undefined, // title uses default
        "Custom description override", // description override
      );

      const updatedFeature = missionStore.getFeature(feature.id);
      const task = await taskStore.getTask(updatedFeature!.taskId!);

      // Custom description should be used exactly
      expect(task.description).toBe("Custom description override");
      // Mission context should NOT be present
      expect(task.description).not.toContain("Full Mission");
      expect(task.description).not.toContain("Full mission description");
      expect(task.description).not.toContain("Full Milestone");
    });

    it("triageSlice enriches all feature tasks with hierarchy context", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create hierarchy with multiple features
      const mission = missionStore.createMission({
        title: "Multi Feature Mission",
        description: "Testing multiple features",
      });

      const milestone = missionStore.addMilestone(mission.id, {
        title: "Multi Feature Milestone",
        description: "Multiple features milestone",
        verification: "All features complete",
        planningNotes: "Coordinate development",
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "Multi Feature Slice",
        description: "Multiple features slice",
        verification: "Slice verification",
        planningNotes: "Slice planning",
      });

      // Add 3 features
      const feature1 = missionStore.addFeature(slice.id, {
        title: "Feature One",
        description: "First feature description",
        acceptanceCriteria: "First criterion",
      });

      const feature2 = missionStore.addFeature(slice.id, {
        title: "Feature Two",
        description: "Second feature description",
        acceptanceCriteria: "Second criterion",
      });

      const feature3 = missionStore.addFeature(slice.id, {
        title: "Feature Three",
        description: "Third feature description",
        acceptanceCriteria: "Third criterion",
      });

      // Triage all features in the slice
      await missionStore.triageSlice(slice.id);

      // Check all 3 tasks have enriched descriptions
      for (const feature of [feature1, feature2, feature3]) {
        const updatedFeature = missionStore.getFeature(feature.id);
        const task = await taskStore.getTask(updatedFeature!.taskId!);

        // All tasks should have hierarchy context
        expect(task.description).toContain("Multi Feature Mission");
        expect(task.description).toContain("Multi Feature Milestone");
        expect(task.description).toContain("Multi Feature Slice");
        // Each task should have its own feature-specific content
        expect(task.description).toContain(feature.title);
        expect(task.description).toContain(feature.description!);
        expect(task.description).toContain(feature.acceptanceCriteria!);
      }
    });

    it("enriched description reflects updates after interview", async () => {
      const missionStore = taskStore.getMissionStore();

      // Create initial hierarchy
      const mission = missionStore.createMission({
        title: "Evolving Mission",
        description: "Initial mission",
      });

      const milestone = missionStore.addMilestone(mission.id, {
        title: "Evolving Milestone",
        description: "Initial milestone",
        planningNotes: "Initial notes",
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "Evolving Slice",
        description: "Initial slice",
        planningNotes: "Initial slice notes",
      });

      const feature1 = missionStore.addFeature(slice.id, {
        title: "Feature Alpha",
        description: "First feature",
      });

      const feature2 = missionStore.addFeature(slice.id, {
        title: "Feature Beta",
        description: "Second feature",
      });

      // Triage first feature
      await missionStore.triageFeature(feature1.id);
      const task1 = await taskStore.getTask(missionStore.getFeature(feature1.id)!.taskId!);

      // Verify initial enrichment
      expect(task1.description).toContain("Initial notes");
      expect(task1.description).toContain("Initial slice notes");

      // Update milestone and slice after "interview"
      missionStore.updateMilestone(milestone.id, {
        planningNotes: "Revised milestone planning: Use JWT tokens, add refresh token support",
      });

      missionStore.updateSlice(slice.id, {
        planningNotes: "Revised slice planning: Use React Hook Form, add validation",
      });

      // Triage second feature
      await missionStore.triageFeature(feature2.id);
      const task2 = await taskStore.getTask(missionStore.getFeature(feature2.id)!.taskId!);

      // Second task should have updated planning notes
      expect(task2.description).toContain("Revised milestone planning");
      expect(task2.description).toContain("Revised slice planning");
      // First task should still have original notes (historical)
      expect(task1.description).toContain("Initial notes");
    });
  });

  describe("planState transitions", () => {
    it("defaults planState to not_started for new slices", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Plan State Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });

      expect(slice.planState).toBe("not_started");
    });

    it("transitions planState to planned after interview", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Plan State Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });

      // Simulate interview completion by updating planState
      const updated = missionStore.updateSlice(slice.id, {
        planState: "planned",
        planningNotes: "Interview completed with decisions documented",
        verification: "All acceptance criteria met",
      });

      expect(updated.planState).toBe("planned");
      expect(updated.planningNotes).toBe("Interview completed with decisions documented");
      expect(updated.verification).toBe("All acceptance criteria met");
    });

    it("transitions planState to needs_update when revisions needed", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Plan State Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, {
        title: "Test Slice",
      });

      // Slice should default to not_started
      expect(slice.planState).toBe("not_started");

      // Simulate interview completion by updating planState
      let updated = missionStore.updateSlice(slice.id, {
        planState: "planned",
        planningNotes: "Interview completed with decisions documented",
        verification: "All acceptance criteria met",
      });

      expect(updated.planState).toBe("planned");

      // Simulate requesting updates
      updated = missionStore.updateSlice(slice.id, {
        planState: "needs_update",
      });

      expect(updated.planState).toBe("needs_update");
    });

    it("planState changes do not affect milestone or mission status", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Status Test" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, {
        title: "Test Slice",
      });

      // New missions are "planning" status
      expect(mission.status).toBe("planning");
      // New milestones are "planning" status
      expect(milestone.status).toBe("planning");
      expect(slice.status).toBe("pending");
      expect(slice.status).toBe("pending");

      // Change planState multiple times
      missionStore.updateSlice(slice.id, { planState: "planned" });
      missionStore.updateSlice(slice.id, { planState: "needs_update" });
      missionStore.updateSlice(slice.id, { planState: "planned" });

      // Status should remain unchanged
      const refreshedMission = missionStore.getMission(mission.id);
      const refreshedMilestone = missionStore.getMilestone(milestone.id);
      const refreshedSlice = missionStore.getSlice(slice.id);

      expect(refreshedMission?.status).toBe("planning");
      expect(refreshedMilestone?.status).toBe("planning");
      expect(refreshedSlice?.status).toBe("pending");
    });
  });

  describe("milestone interview state integration", () => {
    it("milestone interviewState transitions work correctly", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({ title: "Interview Test" });
      const milestone = missionStore.addMilestone(mission.id, {
        title: "Test Milestone",
      });

      // interviewState defaults to not_started
      expect(milestone.interviewState).toBe("not_started");

      // Transition to in_progress
      let updated = missionStore.updateMilestone(milestone.id, {
        interviewState: "in_progress",
      });
      expect(updated.interviewState).toBe("in_progress");

      // Complete the interview
      updated = missionStore.updateMilestone(milestone.id, {
        interviewState: "completed",
        planningNotes: "Interview completed successfully",
        verification: "All requirements captured",
      });
      expect(updated.interviewState).toBe("completed");
      expect(updated.planningNotes).toBe("Interview completed successfully");
      expect(updated.verification).toBe("All requirements captured");

      // Request update
      updated = missionStore.updateMilestone(milestone.id, {
        interviewState: "needs_update",
      });
      expect(updated.interviewState).toBe("needs_update");
    });

    it("enriched description includes milestone interview state", async () => {
      const missionStore = taskStore.getMissionStore();

      const mission = missionStore.createMission({
        title: "Interview Context Test",
        description: "Mission with interview context",
      });

      // First create milestone, then update with interview results
      const milestone = missionStore.addMilestone(mission.id, {
        title: "Interviewed Milestone",
        description: "Milestone after interview",
      });

      // Simulate interview completion
      missionStore.updateMilestone(milestone.id, {
        interviewState: "completed",
        verification: "Verified criteria",
        planningNotes: "Key decisions from interview",
      });

      const slice = missionStore.addSlice(milestone.id, {
        title: "Test Slice",
      });

      const feature = missionStore.addFeature(slice.id, {
        title: "Test Feature",
        description: "Feature description",
      });

      const enriched = missionStore.buildEnrichedDescription(feature.id);

      expect(enriched).toContain("Interviewed Milestone");
      expect(enriched).toContain("Key decisions from interview");
      expect(enriched).toContain("Verified criteria");
    });
  });
});
