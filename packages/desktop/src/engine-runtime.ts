import { basename } from "node:path";

import type { CentralCore, RegisteredProject } from "@fusion/core";

/*
 * FNXC:DesktopRuntime 2026-06-21-02:04:
 * Desktop local mode starts engines by default, so the embedded server should prefer the project represented by the desktop runtime root instead of whichever registered engine happens to be first. The runtime root may be a home directory, so this path must not call helpers that initialize Git repositories as a side effect.
 */
export async function ensureDesktopRuntimeProject(centralCore: CentralCore, rootDir: string): Promise<RegisteredProject> {
  const existing = await centralCore.getProjectByPath(rootDir);
  if (existing) {
    return existing;
  }

  const projects = await centralCore.listProjects();
  if (projects.length > 0) {
    return projects[0]!;
  }

  const registered = await centralCore.registerProject({
    path: rootDir,
    name: basename(rootDir) || "Fusion Desktop",
    isolationMode: "in-process",
  });
  return centralCore.updateProject(registered.id, { status: "active" });
}
