import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createTaskStoreForBackend, exportSettings, generateExportFilename } from "@fusion/core";
import { closeProjectStore, resolveProject, type ProjectContext } from "../project-context.js";

/**
 * Run settings export command.
 * Usage: fn settings export [--output <path>] [--scope global|project|both]
 *
 * @param options.output - Custom output file path (optional, auto-generates if not provided)
 * @param options.scope - Which settings to export: 'global', 'project', or 'both' (default: 'both')
 * @param options.projectName - Optional project name for project-scoped export
 */
export async function runSettingsExport(options: {
  output?: string;
  scope?: "global" | "project" | "both";
  projectName?: string;
} = {}): Promise<void> {
  const scope = options.scope ?? "both";
  let project: ProjectContext | undefined;
  let rootDir = process.cwd();
  try {
    project = options.projectName ? await resolveProject(options.projectName) : undefined;
    rootDir = project?.projectPath ?? rootDir;
  } finally {
    /* FNXC:PostgresCliLifecycle 2026-07-14-21:20: Settings export uses a separate backend boot, so a project context opened only to resolve its root must be closed and evicted before export begins, including when later startup or export work fails. */
    if (project) await closeProjectStore(project);
  }

  // FNXC:PostgresFinalCutover 2026-07-14-17:20: Settings export always uses the
  // PostgreSQL startup factory; the removed SQLite opt-out has no runtime path.
  const boot = await createTaskStoreForBackend({ rootDir });
  const store = boot.taskStore;
  const outputPath = options.output;

  /* FNXC:PostgresCliLifecycle 2026-07-14-19:10: A one-shot settings export must release the startup factory owner before process.exit; store.close alone cannot stop an embedded PostgreSQL cluster. */
  let backendShutdown: (() => Promise<void>) | undefined = boot.shutdown;
  const exitWithBackend = async (code: number): Promise<never> => {
    const shutdown = backendShutdown;
    backendShutdown = undefined;
    await shutdown?.();
    return process.exit(code);
  };

  try {
    const exportData = await exportSettings(store, { scope });

    let targetPath: string;
    if (outputPath) {
      targetPath = resolve(outputPath);
    } else {
      const filename = generateExportFilename();
      targetPath = join(process.cwd(), filename);
    }

    const jsonContent = JSON.stringify(exportData, null, 2);
    await writeFile(targetPath, jsonContent);

    console.log();
    console.log(`  ✓ Settings exported to ${targetPath}`);

    const parts: string[] = [];
    if (exportData.global) {
      const globalKeys = Object.keys(exportData.global).filter(
        (k) => exportData.global?.[k as keyof typeof exportData.global] !== undefined
      );
      if (globalKeys.length > 0) {
        parts.push(`${globalKeys.length} global setting(s)`);
      }
    }
    if (exportData.project) {
      const projectKeys = Object.keys(exportData.project).filter(
        (k) => exportData.project?.[k as keyof typeof exportData.project] !== undefined
      );
      if (projectKeys.length > 0) {
        parts.push(`${projectKeys.length} project setting(s)`);
      }
    }

    if (parts.length > 0) {
      console.log(`    Exported: ${parts.join(", ")}`);
    }
    console.log();

    await exitWithBackend(0);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    await exitWithBackend(1);
  }
}
