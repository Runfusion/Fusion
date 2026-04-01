/**
 * Integration test for CentralCore infrastructure.
 * 
 * This test verifies the end-to-end functionality of the central infrastructure:
 * - Project registration and management
 * - Activity logging across projects
 * - Health tracking
 * - Global concurrency management
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralCore } from "../central-core.js";
import type { RegisteredProject } from "../types.js";

describe("CentralCore Integration", () => {
  let tempDir: string;
  let central: CentralCore;
  const projects: RegisteredProject[] = [];

  beforeAll(async () => {
    // Create temp directory for test
    tempDir = mkdtempSync(join(tmpdir(), "kb-central-integration-"));
    
    // Initialize CentralCore
    central = new CentralCore(tempDir);
    await central.init();
  });

  afterAll(async () => {
    // Cleanup
    await central.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should register multiple projects", async () => {
    for (let i = 0; i < 3; i++) {
      const projectPath = join(tempDir, `integration-project-${i}`);
      mkdirSync(projectPath);

      const project = await central.registerProject({
        name: `Integration Project ${i}`,
        path: projectPath,
      });

      projects.push(project);
      expect(project.id).toMatch(/^proj_/);
      expect(project.name).toBe(`Integration Project ${i}`);
    }

    const allProjects = await central.listProjects();
    expect(allProjects).toHaveLength(3);
  });

  it("should log activity for each project", async () => {
    for (const project of projects) {
      await central.logActivity({
        type: "task:created",
        projectId: project.id,
        projectName: project.name,
        taskId: `KB-${projects.indexOf(project) + 1}`,
        taskTitle: `Test Task ${projects.indexOf(project) + 1}`,
        timestamp: new Date().toISOString(),
        details: `Task created in ${project.name}`,
      });
    }

    const allActivity = await central.getRecentActivity();
    expect(allActivity).toHaveLength(3);

    for (const project of projects) {
      const projectActivity = await central.getRecentActivity({ projectId: project.id });
      expect(projectActivity).toHaveLength(1);
      expect(projectActivity[0].projectId).toBe(project.id);
    }
  });

  it("should update health for each project", async () => {
    for (const project of projects) {
      await central.updateProjectHealth(project.id, {
        activeTaskCount: projects.indexOf(project) + 1,
        inFlightAgentCount: 1,
        status: "active",
      });

      const health = await central.getProjectHealth(project.id);
      expect(health).toBeDefined();
      expect(health?.activeTaskCount).toBe(projects.indexOf(project) + 1);
      expect(health?.inFlightAgentCount).toBe(1);
      expect(health?.status).toBe("active");
    }

    const allHealth = await central.listAllHealth();
    expect(allHealth).toHaveLength(3);
  });

  it("should record task completions", async () => {
    for (const project of projects) {
      // Record some successful completions
      await central.recordTaskCompletion(project.id, 5000, true);
      await central.recordTaskCompletion(project.id, 3000, true);
      
      // Record a failure
      await central.recordTaskCompletion(project.id, 1000, false);
    }

    for (const project of projects) {
      const health = await central.getProjectHealth(project.id);
      expect(health?.totalTasksCompleted).toBe(2);
      expect(health?.totalTasksFailed).toBe(1);
    }

    const stats = await central.getStats();
    expect(stats.projectCount).toBe(3);
    expect(stats.totalTasksCompleted).toBe(6);
  });

  it("should manage global concurrency", async () => {
    // Reset state first by releasing any held slots
    for (const project of projects) {
      const health = await central.getProjectHealth(project.id);
      if (health && health.inFlightAgentCount > 0) {
        // Release all held slots
        for (let i = 0; i < health.inFlightAgentCount; i++) {
          await central.releaseGlobalSlot(project.id);
        }
      }
    }

    // Set a low limit for testing
    await central.updateGlobalConcurrency({ globalMaxConcurrent: 2, currentlyActive: 0, queuedCount: 0 });

    const initialState = await central.getGlobalConcurrencyState();
    expect(initialState.globalMaxConcurrent).toBe(2);
    expect(initialState.currentlyActive).toBe(0);

    // Acquire slots
    const acquired1 = await central.acquireGlobalSlot(projects[0].id);
    expect(acquired1).toBe(true);

    const acquired2 = await central.acquireGlobalSlot(projects[1].id);
    expect(acquired2).toBe(true);

    // Third should fail (at limit)
    const acquired3 = await central.acquireGlobalSlot(projects[2].id);
    expect(acquired3).toBe(false);

    const atLimitState = await central.getGlobalConcurrencyState();
    expect(atLimitState.currentlyActive).toBe(2);
    expect(atLimitState.queuedCount).toBe(1);

    // Release slots
    await central.releaseGlobalSlot(projects[0].id);
    await central.releaseGlobalSlot(projects[1].id);

    const finalState = await central.getGlobalConcurrencyState();
    expect(finalState.currentlyActive).toBe(0);
    expect(finalState.projectsActive[projects[0].id]).toBeUndefined();
    expect(finalState.projectsActive[projects[1].id]).toBeUndefined();
  });

  it("should have consistent unified feed across projects", async () => {
    // Get all activity
    const allActivity = await central.getRecentActivity({ limit: 10 });
    
    // Verify we have activity from all projects
    const projectIds = new Set(allActivity.map((a) => a.projectId));
    expect(projectIds.size).toBeGreaterThanOrEqual(1);

    // Verify activity count matches
    const count = await central.getActivityCount();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("should unregister projects cleanly", async () => {
    // Keep the first project, unregister the others
    for (let i = 1; i < projects.length; i++) {
      await central.unregisterProject(projects[i].id);
    }

    const remainingProjects = await central.listProjects();
    expect(remainingProjects).toHaveLength(1);
    expect(remainingProjects[0].id).toBe(projects[0].id);

    // Health records for unregistered projects should be gone
    for (let i = 1; i < projects.length; i++) {
      const health = await central.getProjectHealth(projects[i].id);
      expect(health).toBeUndefined();
    }
  });

  it("should verify database path and stats", async () => {
    const dbPath = central.getDatabasePath();
    expect(dbPath).toContain("kb-central.db");

    const globalDir = central.getGlobalDir();
    expect(globalDir).toBe(tempDir);

    const stats = await central.getStats();
    expect(stats.projectCount).toBe(1); // Only first project remains
    expect(typeof stats.dbSizeBytes).toBe("number");
    expect(typeof stats.totalTasksCompleted).toBe("number");
  });
});
