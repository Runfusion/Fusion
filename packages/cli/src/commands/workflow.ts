import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TaskStore } from "@fusion/core";
import { validateWorkflowIrDryRun } from "@fusion/engine";
import { getStore } from "../project-resolver.js";

export interface RunWorkflowValidateOptions {
  workflowId?: string;
  file?: string;
  projectName?: string;
  json?: boolean;
}

async function resolveStore(projectName?: string): Promise<TaskStore> {
  try {
    return await getStore({ project: projectName });
  } catch (error) {
    if (projectName) throw error;
    const store = new TaskStore(process.cwd());
    await store.init();
    return store;
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

  let store: TaskStore | undefined;
  try {
    store = await resolveStore(opts.projectName);
    let ir: unknown;
    if (opts.file) {
      const filePath = resolve(opts.file);
      try {
        ir = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        const message = `Failed to read or parse workflow IR file '${opts.file}': ${error instanceof Error ? error.message : String(error)}`;
        if (opts.json) printJsonAndExit({ valid: false, error: message }, 2);
        console.error(message);
        process.exit(2);
      }
    } else {
      const def = await store.getWorkflowDefinition(workflowId!);
      if (!def) {
        const message = `Workflow '${workflowId}' not found`;
        if (opts.json) printJsonAndExit({ valid: false, error: message }, 2);
        console.error(message);
        process.exit(2);
      }
      ir = def.ir;
    }

    const result = await validateWorkflowIrDryRun(store, ir, false);
    if (opts.json) printJsonAndExit(result.valid ? { valid: true } : { valid: false, errors: result.errors }, result.valid ? 0 : 1);
    if (result.valid) {
      console.log("✓ Workflow IR is valid. No workflow was created or mutated.");
      process.exit(0);
    }
    console.error("✗ Workflow IR is invalid:");
    for (const error of result.errors) console.error(`  - ${error.message}`);
    process.exit(1);
  } finally {
    await store?.close?.().catch(() => {});
  }
}
