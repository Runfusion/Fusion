import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TaskStore, importSettings, readExportFile, validateImportData } from "@fusion/core";
import { resolveProject } from "../project-context.js";

/**
 * Run settings import command.
 * Usage: fn settings import <file> [--scope global|project|both] [--merge] [--yes]
 *
 * @param filePath - Path to the JSON file to import
 * @param options.scope - Which settings to import: 'global', 'project', or 'both' (default: 'both')
 * @param options.merge - Whether to merge (true, default) or replace (false) existing settings
 * @param options.yes - Skip confirmation prompt
 * @param options.projectName - Optional project name for project-scoped import
 */
export async function runSettingsImport(
  filePath: string,
  options: {
    scope?: "global" | "project" | "both";
    merge?: boolean;
    yes?: boolean;
    projectName?: string;
  } = {}
): Promise<void> {
  const scope = options.scope ?? "both";
  const project = options.projectName ? await resolveProject(options.projectName) : undefined;

  const store = new TaskStore(project?.projectPath ?? process.cwd());
  await store.init();
  const merge = options.merge ?? true;
  const skipConfirm = options.yes ?? false;

  try {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }

    let importData;
    try {
      importData = await readExportFile(resolvedPath);
    } catch (err) {
      console.error(`Error: Failed to read import file: ${(err as Error).message}`);
      process.exit(1);
    }

    const validationErrors = validateImportData(importData);
    if (validationErrors.length > 0) {
      console.error("Error: Invalid import file:");
      for (const error of validationErrors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }

    const summary: string[] = [];

    if ((scope === "global" || scope === "both") && importData.global) {
      const globalKeys = Object.keys(importData.global).filter(
        (k) => importData.global?.[k as keyof typeof importData.global] !== undefined
      );
      if (globalKeys.length > 0) {
        summary.push(`  Global: ${globalKeys.length} setting(s)`);
      }
    }

    if ((scope === "project" || scope === "both") && importData.project) {
      const projectKeys = Object.keys(importData.project).filter(
        (k) => importData.project?.[k as keyof typeof importData.project] !== undefined
      );
      if (projectKeys.length > 0) {
        summary.push(`  Project: ${projectKeys.length} setting(s)`);
      }
    }

    if (summary.length === 0) {
      console.error("Error: No settings to import in the specified scope");
      process.exit(1);
    }

    console.log();
    console.log("  Import Summary:");
    console.log(`  Source: ${resolvedPath}`);
    console.log(`  Scope: ${scope}`);
    console.log(`  Mode: ${merge ? "merge" : "replace"}`);
    console.log();
    for (const line of summary) {
      console.log(line);
    }
    console.log();

    if (!skipConfirm) {
      console.log("  Use --yes to confirm this import operation");
      console.log();
      process.exit(1);
    }

    const result = await importSettings(store, importData, { scope, merge });

    if (!result.success) {
      console.error(`Error: Import failed: ${result.error}`);
      process.exit(1);
    }

    console.log(`  ✓ Settings imported successfully`);
    if (result.globalCount > 0) {
      console.log(`    Imported ${result.globalCount} global setting(s)`);
    }
    if (result.projectCount > 0) {
      console.log(`    Imported ${result.projectCount} project setting(s)`);
    }
    if (result.workflowSettingsCount > 0) {
      console.log(`    Upgraded ${result.workflowSettingsCount} workflow setting value(s)`);
    }
    console.log();

    process.exit(0);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
