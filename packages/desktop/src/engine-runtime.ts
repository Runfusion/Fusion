import type { CentralCore, RegisteredProject } from "@fusion/core";

/*
 * FNXC:DesktopRuntime 2026-07-03-03:30:
 * The desktop app must NEVER auto-register a project for its runtime root (the user's home
 * directory). Doing so created a bogus "cwd-mode" project in ~ on first launch and dropped the
 * operator straight onto a board for a directory they never chose. Instead the embedded runtime
 * starts with NO default project when none exist, and the dashboard's empty state prompts the
 * operator through onboarding (ProjectOverview "Add your first project" -> SetupWizard ->
 * POST /api/projects) to register a real project directory.
 *
 * This resolver only PICKS an existing project as the primary engine target (for operators who
 * already onboarded projects); it registers nothing. Returns null when there are no projects yet.
 * It must not call helpers that initialize Git repositories as a side effect.
 */
export async function resolveDesktopRuntimePrimaryProject(
  centralCore: CentralCore,
): Promise<RegisteredProject | null> {
  const projects = await centralCore.listProjects();
  return projects.length > 0 ? projects[0]! : null;
}
