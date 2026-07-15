import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTaskStoreForBackend, type TaskStore } from "@fusion/core";
import { validateWorkflowIrDryRun } from "@fusion/engine";
import { cleanupProjectResolution, getStore } from "../project-resolver.js";

export interface RunWorkflowValidateOptions {
  workflowId?: string;
  file?: string;
  projectName?: string;
  json?: boolean;
}

interface OwnedWorkflowStore {
  store: TaskStore;
  shutdown: () => Promise<void>;
}

async function resolveStore(projectName?: string): Promise<OwnedWorkflowStore> {
  try {
    const store = await getStore({ project: projectName });
    return { store, shutdown: cleanupProjectResolution };
  } catch (error) {
    if (projectName) throw error;
    // FNXC:PostgresFinalCutover 2026-07-14-17:20: An unregistered CWD still
    // validates workflows against PostgreSQL; it must not revive TaskStore's removed SQLite runtime.
    const boot = await createTaskStoreForBackend({ rootDir: process.cwd() });
    return { store: boot.taskStore, shutdown: boot.shutdown };
  }
}

function printJsonAndExit(payload: unknown, code: number): never {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

/**
 * FNXC:WorkflowCli 2026-07-12-00:00:
 * Workflow authors need a script-friendly dry-run command that can validate a saved workflow id or an IR JSON file without creating or mutating workflow rows.
 */
export async function runWorkflowValidate(opts: RunWorkflowValidateOptions): Promise<void> {
  const workflowId = opts.workflowId?.trim();
  if (!workflowId && !opts.file) {
    const message = "Usage: fn workflow validate <id> | --file <path> [--json]";
    if (opts.json) printJsonAndExit({ valid: false, error: message }, 2);
    console.error(message);
    process.exit(2);
  }

  let owned: OwnedWorkflowStore | undefined;
  try {
    owned = await resolveStore(opts.projectName);
    const store = owned.store;
    /* FNXC:PostgresCliLifecycle 2026-07-14-19:10: Workflow validation must await the exact startup owner before any process exit; a finally block is insufficient because process.exit skips pending cleanup. */
    const exitWithStore = async (payload: unknown | undefined, code: number): Promise<never> => {
      if (payload !== undefined) console.log(JSON.stringify(payload, null, 2));
      const current = owned;
      owned = undefined;
      await current!.shutdown();
      return process.exit(code);
    };
    let ir: unknown;
    if (opts.file) {
      const filePath = resolve(opts.file);
      try {
        ir = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        const message = `Failed to read or parse workflow IR file '${opts.file}': ${error instanceof Error ? error.message : String(error)}`;
        if (opts.json) return await exitWithStore({ valid: false, error: message }, 2);
        console.error(message);
        return await exitWithStore(undefined, 2);
      }
    } else {
      const def = await store.getWorkflowDefinition(workflowId!);
      if (!def) {
        const message = `Workflow '${workflowId}' not found`;
        if (opts.json) return await exitWithStore({ valid: false, error: message }, 2);
        console.error(message);
        return await exitWithStore(undefined, 2);
      }
      ir = def.ir;
    }

    const result = await validateWorkflowIrDryRun(store, ir, false);
    if (opts.json) return await exitWithStore(result.valid ? { valid: true } : { valid: false, errors: result.errors }, result.valid ? 0 : 1);
    if (result.valid) {
      console.log("✓ Workflow IR is valid. No workflow was created or mutated.");
      return await exitWithStore(undefined, 0);
    }
    console.error("✗ Workflow IR is invalid:");
    for (const error of result.errors) console.error(`  - ${error.message}`);
    return await exitWithStore(undefined, 1);
  } finally {
    const current = owned;
    owned = undefined;
    await current?.shutdown().catch(() => undefined);
  }
}
