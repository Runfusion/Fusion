import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore } from "../central-core.js";

describe("CentralCore.transitionProjectIsolation", () => {
  let tempDir: string;
  let projectPath: string;
  let core: CentralCore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fn-project-isolation-transition-"));
    projectPath = join(tempDir, "project");
    mkdirSync(projectPath, { recursive: true });
    core = new CentralCore(tempDir);
    await core.init();
  });

  afterEach(async () => {
    await core.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("returns noop when next mode matches existing mode", async () => {
    const project = await core.registerProject({
      name: "Test",
      path: projectPath,
      isolationMode: "in-process",
    });

    const result = await core.transitionProjectIsolation(project.id, "in-process");
    expect(result).toEqual({ ok: false, reason: "noop" });
  });

  it("updates mode and logs activity on success", async () => {
    const project = await core.registerProject({
      name: "Test",
      path: projectPath,
      isolationMode: "in-process",
    });

    const result = await core.transitionProjectIsolation(project.id, "child-process");
    expect(result).toEqual({ ok: true });

    const updated = await core.getProject(project.id);
    expect(updated?.isolationMode).toBe("child-process");

    const activity = await core.getRecentActivity({ projectId: project.id, limit: 10 });
    expect(activity.some((entry) => entry.type === "project:isolation-transition")).toBe(true);
  });
});
