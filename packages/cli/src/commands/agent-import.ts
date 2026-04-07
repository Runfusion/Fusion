/**
 * CLI command for importing agents from companies.sh manifests.
 *
 * Usage:
 *   fn agent import <source> [--dry-run] [--skip-existing] [--project <name>]
 *
 * @module agent-import
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentStore, parseCompaniesShManifest, convertCompaniesShAgents, CompaniesShParseError } from "@fusion/core";
import { resolveProject } from "../project-context.js";

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
  companyName: string,
  created: string[],
  skipped: string[],
  errors: Array<{ name: string; error: string }>,
  dryRun: boolean,
): void {
  const prefix = dryRun ? "[DRY RUN] " : "";
  console.log();
  console.log(`  ${prefix}Import from company: ${companyName}`);
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

/**
 * Run the agent import command.
 *
 * @param source - File path to a companies.sh manifest
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

  // Resolve file path
  const filePath = resolve(source);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Read and parse manifest
  let manifest;
  try {
    const content = readFileSync(filePath, "utf-8");
    manifest = parseCompaniesShManifest(content);
  } catch (err) {
    if (err instanceof CompaniesShParseError) {
      console.error(`Parse error: ${err.message}`);
      process.exit(1);
    }
    console.error(`Error reading file: ${(err as Error).message}`);
    process.exit(1);
  }

  if (manifest.agents.length === 0) {
    console.log();
    console.log("  No agents found in manifest");
    console.log();
    return;
  }

  // Get existing agent names for skip logic
  const projectPath = await getProjectPath(options?.project);
  const agentStore = new AgentStore({ rootDir: projectPath + "/.fusion" });
  await agentStore.init();

  const existingAgents = await agentStore.listAgents();
  const existingNames = new Set(existingAgents.map((a) => a.name));

  // Convert agents
  const { inputs, result } = convertCompaniesShAgents(
    manifest.agents,
    skipExisting ? { skipExisting: [...existingNames] } : undefined,
  );

  // Dry run: just preview
  if (dryRun) {
    printSummary(manifest.companyName, result.created, result.skipped, result.errors, true);
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

  printSummary(manifest.companyName, created, result.skipped, errors, false);
}
