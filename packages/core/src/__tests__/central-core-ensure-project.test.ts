import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { CentralCore } from "../central-core.js";
import { ProjectIdentityConflictError } from "../project-identity.js";

const execFileAsync = promisify(execFile);

async function isGitRepository(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

describe("CentralCore.ensureProjectForPath", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

  it("covers existing, reattach, fresh, and conflict", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "central-"));
    const p1 = mkdtempSync(join(tmpdir(), "proj-a-"));
    const p2 = mkdtempSync(join(tmpdir(), "proj-b-"));
    mkdirSync(join(p1, ".fusion"));
    mkdirSync(join(p2, ".fusion"));
    cleanup.push(globalDir, p1, p2);

    const central = new CentralCore(globalDir);
    await central.init();

    const first = await central.ensureProjectForPath({ path: p1, name: "A" });
    expect(first.reattached).toBe(false);
    expect(first.gitRepository).toBe("initialized");
    await expect(isGitRepository(p1)).resolves.toBe(true);

    const existing = await central.ensureProjectForPath({ path: p1, name: "A" });
    expect(existing.outcome).toBe("existing");
    expect(existing.gitRepository).toBeUndefined();

    await central.unregisterProject(first.project.id);
    const events: Array<[string, string]> = [];
    central.on("project:reattached", (project, reason) => events.push([project.id, reason]));
    const reattached = await central.ensureProjectForPath({
      path: p1,
      name: "A",
      identity: { id: first.project.id, createdAt: first.project.createdAt },
    });
    expect(reattached.reattached).toBe(true);
    expect(reattached.gitRepository).toBe("existing");
    expect(events).toEqual([[first.project.id, "identity-recovered"]]);

    await expect(
      central.ensureProjectForPath({
        path: p2,
        name: "B",
        identity: { id: first.project.id, createdAt: first.project.createdAt },
      }),
    ).rejects.toBeInstanceOf(ProjectIdentityConflictError);

    await central.close();
  });

  it("leaves already-registered legacy paths untouched", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "central-"));
    const projectPath = mkdtempSync(join(tmpdir(), "proj-legacy-"));
    cleanup.push(globalDir, projectPath);

    const central = new CentralCore(globalDir);
    await central.init();

    const registered = await central.registerProject({ path: projectPath, name: "Legacy" });
    expect(existsSync(join(projectPath, ".git"))).toBe(false);

    const ensured = await central.ensureProjectForPath({ path: projectPath, name: "Legacy" });

    expect(ensured.outcome).toBe("existing");
    expect(ensured.project.id).toBe(registered.id);
    expect(ensured.gitRepository).toBeUndefined();
    expect(existsSync(join(projectPath, ".git"))).toBe(false);

    await central.close();
  });

  it("does not persist fresh registrations when git initialization fails", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "central-"));
    const projectPath = mkdtempSync(join(tmpdir(), "proj-fail-"));
    cleanup.push(globalDir, projectPath);

    const central = new CentralCore(globalDir, {
      ensureGitRepositoryForProjectPath: async () => {
        throw new Error("Could not initialize Git repository at project: git is not installed");
      },
    });
    await central.init();

    await expect(central.ensureProjectForPath({ path: projectPath, name: "Fail" })).rejects.toThrow(
      "Could not initialize Git repository",
    );
    await expect(central.getProjectByPath(projectPath)).resolves.toBeUndefined();

    await central.close();
  });

  it("does not persist reattachments when git initialization fails", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "central-"));
    const projectPath = mkdtempSync(join(tmpdir(), "proj-reattach-fail-"));
    cleanup.push(globalDir, projectPath);

    const central = new CentralCore(globalDir, {
      ensureGitRepositoryForProjectPath: async () => {
        throw new Error("Could not initialize Git repository at project: permission denied");
      },
    });
    await central.init();

    await expect(
      central.ensureProjectForPath({
        path: projectPath,
        name: "Fail",
        identity: { id: "proj_abcdef1234567890", createdAt: "2026-06-06T00:00:00.000Z" },
      }),
    ).rejects.toThrow("Could not initialize Git repository");
    await expect(central.getProject("proj_abcdef1234567890")).resolves.toBeUndefined();

    await central.close();
  });
});
