import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TaskStore, createTaskStoreForBackend, importSettings, readExportFile, validateImportData } from "@fusion/core";
import { resolveProjectPathOnly, asLocalProjectContext, closeProjectStore } from "../project-context.js";
import { retryOnLock } from "../lock-retry.js";

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7740 audit finding: `runSettingsImport` resolved a name→path via a
 * cached `resolveProject(projectName)` call it never used `.store` from
 * (path-only leak), THEN built a second, UNCACHED `new TaskStore(...)` that
 * IS the store actually used — and closed neither. Every exit path here is
 * `process.exit(0/1)`, so this specific file did not previously hang the
 * event loop (per project memory: `process.exit()` terminates regardless of
 * open handles), but the leaked handles are still a correctness/discipline
 * gap and, per MEMORY, a pending `finally` never runs after `process.exit()`
 * — so teardown must happen explicitly BEFORE every exit call, not via
 * `finally`. Fixed by: `resolveProjectPathOnly` for the name→path
 * resolution (closes+evicts the cached store internally); wrapping the
 * uncached store in `asLocalProjectContext` + an `exitWithStore`-style
 * closure (mirrors `branch-group.ts`/`agent.ts`) that closes it BEFORE
 * every `process.exit()` call; and wrapping the `importSettings` board
 * mutation in `retryOnLock` so a momentary `database is locked` from an
 * active engine/agent writer is retried instead of failing the import
 * outright.
 */

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
  const projectPath = options.projectName ? await resolveProjectPathOnly(options.projectName) : undefined;

  // FNXC:PostgresCutover 2026-07-04: boot the PostgreSQL backend via the startup
  // factory instead of a legacy SQLite TaskStore whose runtime was removed
  // (VAL-REMOVAL-005). Falls back to legacy only on FUSION_NO_EMBEDDED_PG=1.
  const rootDir = projectPath ?? process.cwd();
  const boot = await createTaskStoreForBackend({ rootDir });
  let store: TaskStore;
  if (boot) {
    store = boot.taskStore;
  } else {
    store = new TaskStore(rootDir);
    await store.init();
  }
  const storeContext = asLocalProjectContext(store);
  const merge = options.merge ?? true;
  const skipConfirm = options.yes ?? false;

  const exitWithStore = async (code: number): Promise<never> => {
    await closeProjectStore(storeContext);
    return process.exit(code);
  };

  try {
    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      console.error(`Error: File not found: ${filePath}`);
      await exitWithStore(1);
      return;
    }

    let importData;
    try {
      importData = await readExportFile(resolvedPath);
    } catch (err) {
      console.error(`Error: Failed to read import file: ${(err as Error).message}`);
      await exitWithStore(1);
      return;
    }

    const validationErrors = validateImportData(importData);
    if (validationErrors.length > 0) {
      console.error("Error: Invalid import file:");
      for (const error of validationErrors) {
        console.error(`  - ${error}`);
      }
      await exitWithStore(1);
      return;
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
      await exitWithStore(1);
      return;
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
      await exitWithStore(1);
      return;
    }

    const result = await retryOnLock(
      () => importSettings(store, importData, { scope, merge }),
      { id: projectPath ?? process.cwd(), action: "import settings" },
    );

    if (!result.success) {
      console.error(`Error: Import failed: ${result.error}`);
      await exitWithStore(1);
      return;
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

    await exitWithStore(0);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    await exitWithStore(1);
  }
}
