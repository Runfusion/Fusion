import { describe, expect, it } from "vitest";
import { resolveDesktopRuntimePrimaryProject } from "../engine-runtime";

/*
 * The desktop embedded runtime must NEVER auto-register a project (e.g. the home directory).
 * resolveDesktopRuntimePrimaryProject only picks an already-registered project as the primary
 * engine target, and registers nothing.
 */
describe("resolveDesktopRuntimePrimaryProject", () => {
  it("returns null when no projects are registered (never auto-registers)", async () => {
    let registerCalled = false;
    const central = {
      listProjects: async () => [],
      registerProject: async () => {
        registerCalled = true;
        throw new Error("resolveDesktopRuntimePrimaryProject must not register a project");
      },
    } as unknown as import("@fusion/core").CentralCore;

    const result = await resolveDesktopRuntimePrimaryProject(central);
    expect(result).toBeNull();
    expect(registerCalled).toBe(false);
  });

  it("skips a paused project so local dashboard startup is not blocked", async () => {
    const projects = [{ id: "proj_paused", status: "paused" }, { id: "proj_active", status: "active" }];
    let registerCalled = false;
    const central = {
      listProjects: async () => projects,
      registerProject: async () => {
        registerCalled = true;
        return projects[0];
      },
    } as unknown as import("@fusion/core").CentralCore;

    const result = await resolveDesktopRuntimePrimaryProject(central);
    expect(result?.id).toBe("proj_active");
    expect(registerCalled).toBe(false);
  });
});
