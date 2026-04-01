/**
 * Project subcommand implementations for kb CLI.
 *
 * Implements:
 * - fn project list [--json]
 * - fn project add [dir] [--name <name>] [--isolation <mode>]
 * - fn project remove <name> [--force]
 * - fn project info [name]
 */

import { CentralCore, type RegisteredProject, type IsolationMode } from "@fusion/core";
import { resolve, isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  getCentralCore,
  getProjectManager,
  resolveProject,
  isKbProject,
  suggestProjectName,
  formatLastActivity,
} from "../project-resolver.js";

const VALID_ISOLATION_MODES: IsolationMode[] = ["in-process", "child-process"];

/**
 * Run the `fn project list` command.
 *
 * Shows all registered projects with:
 * - Name, directory, status
 * - In-flight task count
 * - Last activity timestamp
 * - Optional JSON output with --json flag
 */
export async function runProjectList(options: { json?: boolean } = {}): Promise<void> {
  const central = await getCentralCore();
  const pm = await getProjectManager();

  const projects = await central.listProjects();

  if (projects.length === 0) {
    if (options.json) {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log("\n  No projects registered.");
      console.log("  Register one with: fn project add <path>\n");
    }
    return;
  }

  // Get detailed info for each project
  const projectsWithInfo = await Promise.all(
    projects.map(async (project) => {
      const runtime = pm.getRuntime(project.id);
      const runtimeStatus = runtime?.getStatus() ?? "not_started";

      let taskCounts: Record<string, number> = {};
      let totalTasks = 0;
      let readWarning: string | undefined;
      try {
        const { TaskStore } = await import("@fusion/core");
        const store = new TaskStore(project.path);
        await store.init();
        const tasks = await store.listTasks();
        totalTasks = tasks.length;
        for (const task of tasks) {
          taskCounts[task.column] = (taskCounts[task.column] || 0) + 1;
        }
      } catch (error: any) {
        readWarning = error?.message || "Failed to read project tasks";
      }

      const health = await central.getProjectHealth(project.id);

      return {
        project,
        runtimeStatus,
        taskCounts,
        totalTasks,
        lastActivity: health?.lastActivityAt,
        activeAgents: health?.inFlightAgentCount ?? 0,
        readWarning,
      };
    })
  );

  // Sort by name alphabetically
  projectsWithInfo.sort((a, b) => a.project.name.localeCompare(b.project.name));

  if (options.json) {
    // JSON output
    const jsonOutput = projectsWithInfo.map((p) => ({
      id: p.project.id,
      name: p.project.name,
      path: p.project.path,
      status: p.project.status,
      isolationMode: p.project.isolationMode,
      runtimeStatus: p.runtimeStatus,
      totalTasks: p.totalTasks,
      taskCounts: p.taskCounts,
      activeAgents: p.activeAgents,
      lastActivity: p.lastActivity,
      createdAt: p.project.createdAt,
      updatedAt: p.project.updatedAt,
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    // Table output
    console.log();
    console.log("  Registered Projects:");
    console.log();

    // Calculate column widths
    const nameWidth = Math.max(...projectsWithInfo.map((p) => p.project.name.length), 4);
    const pathWidth = Math.max(...projectsWithInfo.map((p) => p.project.path.length), 4);

    // Header
    console.log(
      `    ${"Name".padEnd(nameWidth)}  ${"Path".padEnd(pathWidth)}  ${"Status".padEnd(10)}  ${"Tasks".padEnd(6)}  ${"Agents".padEnd(6)}  Last Activity`
    );
    console.log(
      `    ${"-".repeat(nameWidth)}  ${"-".repeat(pathWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}  ${"-".repeat(6)}  -------------`
    );

    for (const p of projectsWithInfo) {
      const statusIcon = getStatusIcon(p.project.status);
      const lastActivity = formatLastActivity(p.lastActivity);
      console.log(
        `    ${p.project.name.padEnd(nameWidth)}  ${p.project.path.padEnd(pathWidth)}  ${statusIcon} ${p.project.status.padEnd(8)}  ${String(p.totalTasks).padEnd(6)}  ${String(p.activeAgents).padEnd(6)}  ${lastActivity}`
      );
      if (p.readWarning) {
        console.log(`      warning: ${p.readWarning}`);
      }
    }

    console.log();
    const activeCount = projectsWithInfo.filter((p) => p.project.status === "active").length;
    console.log(`  ${projects.length} project${projects.length === 1 ? "" : "s"} registered, ${activeCount} active`);
    console.log();
  }
}

/**
 * Run the `fn project add` command.
 *
 * Registers a new project with optional interactive prompts.
 */
export async function runProjectAdd(
  dir?: string,
  options: { name?: string; isolation?: "in-process" | "child-process"; interactive?: boolean } = {}
): Promise<void> {
  const central = await getCentralCore();
  const interactive = options.interactive ?? true;

  // Interactive wizard if no directory provided
  if (!dir && interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // Ask for directory
    const cwd = process.cwd();
    const dirInput = await rl.question(`  Project directory [${cwd}]: `);
    dir = dirInput.trim() || cwd;

    // Check if directory has .kb/
    const kbPath = resolve(dir, ".kb");
    if (!existsSync(kbPath)) {
      console.log(`\n  No .kb/ directory found in ${dir}`);
      const shouldInit = await promptConfirmWithRl(rl, "Initialize kb here first?", true);

      if (shouldInit) {
        const { TaskStore } = await import("@fusion/core");
        const store = new TaskStore(dir);
        await store.init();
        console.log(`  ✓ Initialized kb at ${dir}`);
      } else {
        console.log("  Cannot register project without .kb/ directory.");
        rl.close();
        process.exit(1);
      }
    }

    // Ask for name
    const suggestedName = options.name || suggestProjectName(dir);
    const nameInput = await rl.question(`  Project name [${suggestedName}]: `);
    options.name = nameInput.trim() || suggestedName;

    // Ask for isolation mode
    const isolationInput = await rl.question(`  Isolation mode [in-process]: `);
    options.isolation = (isolationInput.trim() as IsolationMode) || "in-process";

    rl.close();
  }

  if (!dir) {
    console.error("Usage: fn project add [dir] [--name <name>] [--isolation <mode>]");
    process.exit(1);
  }

  // Resolve and validate directory
  const absolutePath = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);

  if (!existsSync(absolutePath)) {
    console.error(`Error: Path does not exist: ${absolutePath}`);
    process.exit(1);
  }

  if (!statSync(absolutePath).isDirectory()) {
    console.error(`Error: Path is not a directory: ${absolutePath}`);
    process.exit(1);
  }

  // Check for .kb/ directory
  if (!isKbProject(absolutePath)) {
    console.error(`Error: No kb project found at ${absolutePath}`);
    console.error("Run `fn init` first to initialize a kb project.");
    process.exit(1);
  }

  // Validate isolation mode
  const isolationMode = options.isolation ?? "in-process";
  if (!VALID_ISOLATION_MODES.includes(isolationMode)) {
    console.error(`Error: Invalid isolation mode '${isolationMode}'`);
    console.error(`Valid modes: ${VALID_ISOLATION_MODES.join(", ")}`);
    process.exit(1);
  }

  // Determine project name
  const name = options.name || suggestProjectName(absolutePath);

  // Check for duplicate name
  const existing = await findProjectByName(central, name);
  if (existing) {
    console.error(`Error: Project '${name}' already registered.`);
    process.exit(1);
  }

  // Check for duplicate path
  const existingByPath = await central.getProjectByPath(absolutePath);
  if (existingByPath) {
    console.error(`Error: Project already registered at path: ${absolutePath}`);
    console.error(`Existing project: ${existingByPath.name}`);
    process.exit(1);
  }

  // Register the project
  const project = await central.registerProject({
    name,
    path: absolutePath,
    isolationMode,
  });

  console.log();
  console.log(`  ✓ Registered project '${name}'`);
  console.log(`    ID: ${project.id}`);
  console.log(`    Path: ${project.path}`);
  console.log(`    Isolation: ${project.isolationMode}`);
  console.log();
}

/**
 * Run the `fn project remove` command.
 *
 * Unregisters a project from the central registry.
 */
export async function runProjectRemove(
  name: string,
  options: { force?: boolean; interactive?: boolean } = {}
): Promise<void> {
  const central = await getCentralCore();
  const pm = await getProjectManager();
  const interactive = options.interactive ?? true;

  if (!name) {
    console.error("Usage: fn project remove <name> [--force]");
    process.exit(1);
  }

  const project = await findProjectByNameOrId(central, name);
  if (!project) {
    console.error(`Error: Project '${name}' not found.`);
    process.exit(1);
  }

  // Confirmation prompt
  if (!options.force && interactive) {
    const confirmed = await promptConfirm(
      `Unregister "${project.name}"? Project data will be preserved, only the registry entry will be removed.`,
      false
    );
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  // Check if runtime is active
  const runtime = pm.getRuntime(project.id);
  if (runtime) {
    console.log(`  Stopping runtime for '${project.name}'...`);
    await pm.removeProject(project.id);
  }

  await central.unregisterProject(project.id);

  console.log();
  console.log(`  ✓ Unregistered project '${project.name}'`);
  console.log(`    Project data at ${project.path} is preserved.`);
  console.log();
}

/**
 * Run the `fn project info` command.
 *
 * Shows detailed information about a specific project.
 */
export async function runProjectInfo(name?: string, _options: { interactive?: boolean } = {}): Promise<void> {
  const central = await getCentralCore();
  const pm = await getProjectManager();

  let project: RegisteredProject;

  if (name) {
    const found = await findProjectByNameOrId(central, name);
    if (!found) {
      console.error(`Error: Project '${name}' not found.`);
      process.exit(1);
    }
    project = found;
  } else {
    const resolved = await resolveProject({ interactive: false });
    project = {
      id: resolved.projectId,
      name: resolved.name,
      path: resolved.directory,
      status: resolved.status as RegisteredProject["status"],
      isolationMode: resolved.isolationMode as RegisteredProject["isolationMode"],
      createdAt: "",
      updatedAt: "",
    };

    const storedProject = await central.getProject(resolved.projectId);
    if (storedProject) {
      project = storedProject;
    }
  }

  // Get runtime status
  const runtime = pm.getRuntime(project.id);
  const runtimeStatus = runtime?.getStatus() ?? "not_started";

  let taskCounts: Record<string, number> = {};
  let totalTasks = 0;
  let taskReadWarning: string | undefined;
  try {
    const { TaskStore } = await import("@fusion/core");
    const store = new TaskStore(project.path);
    await store.init();
    const tasks = await store.listTasks();
    totalTasks = tasks.length;
    for (const task of tasks) {
      taskCounts[task.column] = (taskCounts[task.column] || 0) + 1;
    }
  } catch (error: any) {
    taskReadWarning = error?.message || "Failed to read project tasks";
  }

  // Get health metrics
  const health = await central.getProjectHealth(project.id);

  // Display info
  console.log();
  console.log(`  Project: ${project.name}`);
  console.log(`  ID: ${project.id}`);
  console.log(`  Path: ${project.path}`);
  console.log(`  Status: ${project.status}`);
  console.log(`  Isolation Mode: ${project.isolationMode}`);
  console.log(`  Runtime: ${runtimeStatus}`);
  if (project.createdAt) {
    console.log(`  Created: ${new Date(project.createdAt).toLocaleString()}`);
  }
  if (project.updatedAt) {
    console.log(`  Updated: ${new Date(project.updatedAt).toLocaleString()}`);
  }
  console.log();

  console.log(`  Tasks (${totalTasks} total):`);
  const columns = ["triage", "todo", "in-progress", "in-review", "done", "archived"];
  for (const col of columns) {
    const count = taskCounts[col] || 0;
    if (count > 0 || col !== "archived") {
      const icon = getColumnIcon(col);
      console.log(`    ${icon} ${col}: ${count}`);
    }
  }
  if (taskReadWarning) {
    console.log(`  Warning: ${taskReadWarning}`);
    console.log();
  }

  if (health) {
    console.log("  Activity:");
    console.log(`    Active tasks: ${health.activeTaskCount}`);
    console.log(`    In-flight agents: ${health.inFlightAgentCount}`);
    console.log(`    Total completed: ${health.totalTasksCompleted}`);
    console.log(`    Total failed: ${health.totalTasksFailed}`);
    if (health.lastActivityAt) {
      console.log(`    Last activity: ${formatLastActivity(health.lastActivityAt)}`);
    }
    if (health.averageTaskDurationMs) {
      const avgMins = Math.round(health.averageTaskDurationMs / 60000);
      console.log(`    Avg task duration: ${avgMins}m`);
    }
    console.log();
  }
}

// Helper functions

async function findProjectByName(central: CentralCore, name: string): Promise<RegisteredProject | undefined> {
  const allProjects = await central.listProjects();
  const lowerName = name.toLowerCase();
  return allProjects.find((p) => p.name.toLowerCase() === lowerName);
}

async function findProjectByNameOrId(central: CentralCore, nameOrId: string): Promise<RegisteredProject | undefined> {
  // First try exact ID match
  const byId = await central.getProject(nameOrId);
  if (byId) {
    return byId;
  }

  // Then try case-insensitive name match
  return findProjectByName(central, nameOrId);
}

async function promptConfirmWithRl(
  rl: ReturnType<typeof createInterface>,
  message: string,
  defaultYes = false
): Promise<boolean> {
  const prompt = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`  ${message} ${prompt}: `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" && defaultYes) return true;
  return trimmed === "y" || trimmed === "yes";
}

async function promptConfirm(message: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptConfirmWithRl(rl, message, defaultYes);
  } finally {
    rl.close();
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "active":
      return "●";
    case "paused":
      return "⏸";
    case "errored":
      return "✗";
    case "initializing":
      return "◌";
    default:
      return "○";
  }
}

function getColumnIcon(column: string): string {
  switch (column) {
    case "triage":
      return "●";
    case "todo":
      return "○";
    case "in-progress":
      return "▸";
    case "in-review":
      return "◆";
    case "done":
      return "✓";
    case "archived":
      return "▪";
    default:
      return "•";
  }
}
