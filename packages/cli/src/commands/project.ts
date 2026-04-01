/**
 * Project command implementations for kb CLI.
 */

import { CentralCore, GlobalSettingsStore, type RegisteredProject, type IsolationMode } from "@fusion/core";
import { resolve, isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { formatProjectLine, detectProjectFromCwd, setDefaultProject } from "../project-context.js";

const VALID_ISOLATION_MODES: IsolationMode[] = ["in-process", "child-process"];

export async function runProjectList(): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    const projects = await central.listProjects();
    const defaultProject = await getDefaultProject();

    if (projects.length === 0) {
      console.log("\n  No projects registered.");
      console.log("  Register one with: kb project add <name> <path>\n");
      return;
    }

    console.log();
    console.log("  Registered Projects:");
    console.log();

    for (const project of projects) {
      const isDefault = defaultProject?.id === project.id;
      const line = formatProjectLine(project, isDefault);
      console.log(`  ${line}`);
    }

    console.log();
    const activeCount = projects.filter((p) => p.status === "active").length;
    console.log(`  ${projects.length} project${projects.length === 1 ? "" : "s"} registered, ${activeCount} active`);
    if (defaultProject) {
      console.log(`  * indicates default project (${defaultProject.name})`);
    }
    console.log();
  } finally {
    await central.close();
  }
}

export async function runProjectAdd(
  name: string,
  path: string,
  options?: { isolation?: string; force?: boolean }
): Promise<void> {
  if (!name || !path) {
    console.error("Usage: kb project add <name> <path> [--isolation <mode>]");
    process.exit(1);
  }

  if (!isValidProjectName(name)) {
    console.error(`Error: Invalid project name '${name}'`);
    process.exit(1);
  }

  const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);

  if (!existsSync(absolutePath)) {
    console.error(`Error: Path does not exist: ${absolutePath}`);
    process.exit(1);
  }

  if (!statSync(absolutePath).isDirectory()) {
    console.error(`Error: Path is not a directory: ${absolutePath}`);
    process.exit(1);
  }

  const kbDbPath = resolve(absolutePath, ".kb", "kb.db");
  if (!existsSync(kbDbPath) && !options?.force) {
    console.error(`Error: No kb project found at ${absolutePath}`);
    process.exit(1);
  }

  const isolationMode = options?.isolation as IsolationMode | undefined;
  if (isolationMode && !VALID_ISOLATION_MODES.includes(isolationMode)) {
    console.error(`Error: Invalid isolation mode '${isolationMode}'`);
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const existing = await findProjectByName(central, name);
    if (existing) {
      console.error(`Error: Project '${name}' already registered.`);
      process.exit(1);
    }

    const project = await central.registerProject({
      name,
      path: absolutePath,
      isolationMode: isolationMode ?? "in-process",
    });

    console.log();
    console.log(`  ✓ Registered project '${name}'`);
    console.log(`    ID: ${project.id}`);
    console.log();
  } finally {
    await central.close();
  }
}

export async function runProjectRemove(name: string, force?: boolean): Promise<void> {
  if (!name) {
    console.error("Usage: kb project remove <name> [--force]");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const project = await findProjectByNameOrId(central, name);
    if (!project) {
      console.error(`Error: Project '${name}' not found.`);
      process.exit(1);
    }

    if (!force) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Unregister project '${project.name}'? [y/N] `);
      rl.close();

      if (answer.trim().toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    await central.unregisterProject(project.id);
    console.log(`  ✓ Unregistered project '${project.name}'`);
  } finally {
    await central.close();
  }
}

export async function runProjectShow(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: kb project show <name>");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const project = await findProjectByNameOrId(central, name);
    if (!project) {
      console.error(`Error: Project '${name}' not found.`);
      process.exit(1);
    }

    const defaultProject = await getDefaultProject();
    const isDefault = defaultProject?.id === project.id;

    console.log();
    console.log(`  Project: ${project.name}${isDefault ? " (default)" : ""}`);
    console.log(`  ID: ${project.id}`);
    console.log(`  Path: ${project.path}`);
    console.log(`  Status: ${project.status}`);
    console.log();
  } finally {
    await central.close();
  }
}

export async function runProjectSetDefault(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: kb project set-default <name>");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const project = await findProjectByNameOrId(central, name);
    if (!project) {
      console.error(`Error: Project '${name}' not found.`);
      process.exit(1);
    }

    await setDefaultProject(project.id);
    console.log();
    console.log(`  ✓ Set '${project.name}' as default project`);
    console.log();
  } finally {
    await central.close();
  }
}

export async function runProjectDetect(): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    const project = await detectProjectFromCwd(process.cwd(), central);

    if (project) {
      console.log();
      console.log(`  Detected: ${project.name} (${project.path})`);
      console.log();
    } else {
      console.log();
      console.log("  No kb project detected from current directory.");
      console.log();
    }
  } finally {
    await central.close();
  }
}

// Helpers

async function getDefaultProject(): Promise<RegisteredProject | undefined> {
  const globalStore = new GlobalSettingsStore();
  await globalStore.init();

  const settings = await globalStore.getSettings();
  if (!settings.defaultProjectId) {
    return undefined;
  }

  const central = new CentralCore();
  await central.init();
  try {
    return await central.getProject(settings.defaultProjectId);
  } finally {
    await central.close();
  }
}

async function findProjectByName(central: CentralCore, name: string): Promise<RegisteredProject | undefined> {
  const allProjects = await central.listProjects();
  const lowerName = name.toLowerCase();
  return allProjects.find((p) => p.name.toLowerCase() === lowerName);
}

async function findProjectByNameOrId(central: CentralCore, nameOrId: string): Promise<RegisteredProject | undefined> {
  const byId = await central.getProject(nameOrId);
  if (byId) {
    return byId;
  }
  return findProjectByName(central, nameOrId);
}

function isValidProjectName(name: string): boolean {
  if (!name || name.length < 1 || name.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
