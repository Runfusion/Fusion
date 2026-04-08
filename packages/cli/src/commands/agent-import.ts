/**
 * CLI command for importing agents from Agent Companies packages.
 *
 * Usage:
 *   fn agent import <source> [--dry-run] [--skip-existing] [--project <name>]
 *
 * @module agent-import
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentStore,
  parseCompanyDirectory,
  parseCompanyArchive,
  parseAgentManifest,
  convertAgentCompanies,
  AgentCompaniesParseError,
  parseCompaniesShManifest,
  convertCompaniesShAgents,
  CompaniesShParseError,
} from "@fusion/core";
import type { AgentCreateInput } from "@fusion/core";
import { resolveProject } from "../project-context.js";

const UNSUPPORTED_FORMAT_MESSAGE =
  "Unsupported format. Provide a directory, .tar.gz/.zip archive, .md file, or .sh manifest.";

/**
 * Get the project path for agent operations.
 * Falls back to process.cwd() if no project is specified.
 */
async function getProjectPath(projectName?: string): Promise<string> {
  if (projectName) {
    const context = await resolveProject(projectName);
    return context.projectPath;
  }

  try {
    const context = await resolveProject(undefined);
    return context.projectPath;
  } catch {
    return process.cwd();
  }
}

/**
 * Print a summary of the import result.
 */
function printSummary(
  companyName: string | undefined,
  created: string[],
  skipped: string[],
  errors: Array<{ name: string; error: string }>,
  dryRun: boolean,
): void {
  const prefix = dryRun ? "[DRY RUN] " : "";
  console.log();
  console.log(`  ${prefix}Import from company: ${companyName ?? "Unknown"}`);
  console.log(`  ${prefix}Created: ${created.length}`);
  for (const name of created) {
    console.log(`    ✓ ${name}`);
  }
  if (skipped.length > 0) {
    console.log(`  ${prefix}Skipped: ${skipped.length}`);
    for (const name of skipped) {
      console.log(`    ○ ${name}`);
    }
  }
  if (errors.length > 0) {
    console.log(`  ${prefix}Errors: ${errors.length}`);
    for (const err of errors) {
      console.log(`    ✗ ${err.name}: ${err.error}`);
    }
  }
  console.log();
}

function isArchivePath(path: string): boolean {
  return path.endsWith(".tar.gz") || path.endsWith(".tgz") || path.endsWith(".zip");
}

/**
 * Run the agent import command.
 *
 * @param source - Path to an Agent Companies directory/archive/manifest source
 * @param options - Command options
 */
export async function runAgentImport(
  source: string,
  options?: {
    dryRun?: boolean;
    skipExisting?: boolean;
    project?: string;
  },
): Promise<void> {
  const dryRun = options?.dryRun ?? false;
  const skipExisting = options?.skipExisting ?? false;

  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) {
    console.error(`File not found: ${sourcePath}`);
    process.exit(1);
  }

  // Get existing agent names for skip logic
  const projectPath = await getProjectPath(options?.project);
  const agentStore = new AgentStore({ rootDir: projectPath + "/.fusion" });
  await agentStore.init();

  const existingAgents = await agentStore.listAgents();
  const existingNames = new Set(existingAgents.map((a) => a.name));

  let companyName: string | undefined;
  let inputs: AgentCreateInput[] = [];
  let result: {
    created: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } = {
    created: [],
    skipped: [],
    errors: [],
  };

  try {
    const sourceStats = statSync(sourcePath);

    if (sourceStats.isDirectory()) {
      const pkg = parseCompanyDirectory(sourcePath);
      companyName = pkg.company?.name;
      ({ inputs, result } = convertAgentCompanies(
        pkg,
        skipExisting ? { skipExisting: [...existingNames] } : undefined,
      ));
    } else if (isArchivePath(sourcePath)) {
      const pkg = await parseCompanyArchive(sourcePath);
      companyName = pkg.company?.name;
      ({ inputs, result } = convertAgentCompanies(
        pkg,
        skipExisting ? { skipExisting: [...existingNames] } : undefined,
      ));
    } else if (sourcePath.endsWith(".md")) {
      const content = readFileSync(sourcePath, "utf-8");
      const manifest = parseAgentManifest(content);
      const pkg = {
        company: undefined,
        agents: [manifest],
        teams: [],
        projects: [],
        tasks: [],
        skills: [],
      };
      ({ inputs, result } = convertAgentCompanies(
        pkg,
        skipExisting ? { skipExisting: [...existingNames] } : undefined,
      ));
    } else if (sourcePath.endsWith(".sh")) {
      const content = readFileSync(sourcePath, "utf-8");
      const manifest = parseCompaniesShManifest(content);
      companyName = manifest.companyName;
      ({ inputs, result } = convertCompaniesShAgents(
        manifest.agents,
        skipExisting ? { skipExisting: [...existingNames] } : undefined,
      ));
    } else {
      throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
    }
  } catch (err) {
    if (err instanceof AgentCompaniesParseError || err instanceof CompaniesShParseError) {
      console.error(`Parse error: ${err.message}`);
      process.exit(1);
    }

    if (err instanceof Error && err.message === UNSUPPORTED_FORMAT_MESSAGE) {
      console.error(err.message);
      process.exit(1);
    }

    console.error(`Error reading source: ${(err as Error).message}`);
    process.exit(1);
  }

  if (result.created.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log();
    console.log("  No agents found in manifest");
    console.log();
    return;
  }

  // Dry run: just preview
  if (dryRun) {
    printSummary(companyName, result.created, result.skipped, result.errors, true);
    return;
  }

  // Create agents
  const created: string[] = [];
  const errors: Array<{ name: string; error: string }> = [...result.errors];

  for (const input of inputs) {
    try {
      // Double-check for duplicates if not using skipExisting
      if (!skipExisting && existingNames.has(input.name)) {
        errors.push({ name: input.name, error: "Agent with this name already exists" });
        continue;
      }

      await agentStore.createAgent(input);
      created.push(input.name);
    } catch (err) {
      errors.push({ name: input.name, error: (err as Error).message });
    }
  }

  printSummary(companyName, created, result.skipped, errors, false);
}
