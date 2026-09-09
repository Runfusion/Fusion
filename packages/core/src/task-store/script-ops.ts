import { and, eq } from "drizzle-orm";
import type { TaskStore } from "../store.js";
import type { Settings } from "../types.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import * as schema from "../postgres/schema/index.js";
import { projectScopeFor } from "../postgres/data-layer.js";
import { acquireProjectConfigurationMutationLock, readProjectConfig, writeProjectConfig } from "./async/async-settings.js";
import { canonicalizeSettings } from "./settings-helpers.js";
import { publishSettingsUpdated } from "./settings-ops.js";
import { DEFAULT_SETTINGS } from "../config/settings-schema.js";

export interface ScriptMetadata {
  description?: string;
}

export interface MutateScriptInput {
  /** Existing key when editing or deleting. Omit when creating. */
  originalName?: string;
  /** New display/execution key. */
  name: string;
  /** Shell command. Omit only when deleting. */
  command?: string;
  description?: string;
  delete?: boolean;
}

export interface ScriptCatalogEntry {
  name: string;
  command: string;
  description?: string;
}

/** @internal Test-only failure injection at the transaction's final pre-commit boundary. */
let beforeScriptMutationCommitForTesting: (() => void | Promise<void>) | undefined;

/** @internal */
export function __setBeforeScriptMutationCommitForTesting(callback: (() => void | Promise<void>) | undefined): void {
  beforeScriptMutationCommitForTesting = callback;
}

export class ScriptNameConflictError extends Error {
  readonly code = "SCRIPT_NAME_CONFLICT";

  constructor(name: string) {
    super(`Script '${name}' already exists`);
    this.name = "ScriptNameConflictError";
  }
}

function normalizedDescription(value: string | undefined): string | undefined {
  const description = value?.trim();
  return description || undefined;
}

/**
 * Rewrites scriptName references in every graph node, including recursively nested
 * foreach, loop, and optional-group templates. Unknown config remains untouched.
 */
export function renameScriptReferencesInWorkflowIr(ir: WorkflowIr, from: string, to: string): WorkflowIr {
  const clone = structuredClone(ir);
  const visitNodes = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) continue;
      const node = rawNode as Record<string, unknown>;
      const config = node.config;
      if (!config || typeof config !== "object" || Array.isArray(config)) continue;
      const configRecord = config as Record<string, unknown>;
      if (configRecord.scriptName === from) configRecord.scriptName = to;
      const template = configRecord.template;
      if (template && typeof template === "object" && !Array.isArray(template)) {
        visitNodes((template as Record<string, unknown>).nodes);
      }
    }
  };
  visitNodes(clone.nodes);
  return clone;
}

export function scriptCatalogFromSettings(settings: Pick<Settings, "scripts" | "scriptMetadata">): ScriptCatalogEntry[] {
  return Object.entries(settings.scripts ?? {}).map(([name, command]) => ({
    name,
    command,
    ...(settings.scriptMetadata?.[name]?.description
      ? { description: settings.scriptMetadata[name]!.description }
      : {}),
  }));
}

/*
FNXC:TerminalScripts 2026-09-06-19:30:
Quick terminal scripts keep commands in Settings.scripts for every existing execution consumer, while optional descriptions live in a backward-compatible sibling map. Script names are trimmed only at their outer edges so spaces, Unicode, and punctuation remain valid operator-facing names.

FNXC:TerminalScripts 2026-09-06-19:30:
A rename must move command metadata and every project-owned setup, legacy-step, and recursively nested custom-workflow reference in one PostgreSQL transaction. A conflict or failed write therefore leaves the complete catalog and all automation references unchanged.
*/
export async function mutateScriptImpl(store: TaskStore, input: MutateScriptInput): Promise<ScriptCatalogEntry[]> {
  const name = input.name.trim();
  const originalName = (input.originalName ?? name).trim();
  if (!name) throw new Error("Script name is required");
  if (!originalName) throw new Error("Original script name is required");
  if (!input.delete && typeof input.command !== "string") throw new Error("Script command is required");

  return store.withConfigLock(async () => {
    const layer = store.asyncLayer!;
    const projectId = layer.projectId?.trim();
    if (!projectId) throw new Error("Script mutations require a project-scoped data layer");
    const result = await layer.transactionImmediate(async (tx) => {
      // Serialize every project configuration/workflow writer before deriving replacements.
      await acquireProjectConfigurationMutationLock(tx, projectId);
      const projectConfig = await readProjectConfig(layer, tx);
      const rawSettings = (projectConfig.settings ?? {}) as Settings;
      const scripts = { ...(rawSettings.scripts ?? {}) };
      const metadata = { ...(rawSettings.scriptMetadata ?? {}) };
      const renaming = originalName !== name;

      if ((renaming || input.originalName === undefined) && scripts[name] !== undefined) {
        throw new ScriptNameConflictError(name);
      }
      if (input.originalName !== undefined && scripts[originalName] === undefined) {
        throw new Error(`Script '${originalName}' not found`);
      }

      if (input.delete) {
        delete scripts[originalName];
        delete metadata[originalName];
      } else {
        if (renaming) {
          delete scripts[originalName];
          delete metadata[originalName];
        }
        scripts[name] = input.command!.trim();
        const description = normalizedDescription(input.description);
        if (description) metadata[name] = { description };
        else delete metadata[name];
      }

      const nextProjectSettings: Settings = {
        ...rawSettings,
        scripts,
        ...(Object.keys(metadata).length > 0 ? { scriptMetadata: metadata } : {}),
      };
      if (Object.keys(metadata).length === 0) delete nextProjectSettings.scriptMetadata;
      if (renaming && nextProjectSettings.setupScript === originalName) nextProjectSettings.setupScript = name;

      if (renaming) {
        await tx.update(schema.project.workflowSteps)
          .set({ scriptName: name, updatedAt: new Date().toISOString() })
          .where(and(
            eq(schema.project.workflowSteps.scriptName, originalName),
            projectScopeFor(schema.project.workflowSteps.projectId, layer.projectId),
          ));

        const workflowRows = await tx.select({ id: schema.project.workflows.id, ir: schema.project.workflows.ir })
          .from(schema.project.workflows)
          .where(projectScopeFor(schema.project.workflows.projectId, layer.projectId));
        for (const row of workflowRows) {
          const currentIr = row.ir as WorkflowIr;
          const renamedIr = renameScriptReferencesInWorkflowIr(currentIr, originalName, name);
          if (JSON.stringify(renamedIr) !== JSON.stringify(currentIr)) {
            await tx.update(schema.project.workflows)
              .set({ ir: renamedIr, updatedAt: new Date().toISOString() })
              .where(and(
                eq(schema.project.workflows.id, row.id),
                projectScopeFor(schema.project.workflows.projectId, layer.projectId),
              ));
          }
        }
      }

      await writeProjectConfig(layer, nextProjectSettings as Record<string, unknown>, undefined, tx);
      await beforeScriptMutationCommitForTesting?.();
      const globalSettings = await store.globalSettingsStore.getSettings();
      return {
        previous: canonicalizeSettings({ ...DEFAULT_SETTINGS, ...globalSettings, ...rawSettings } as Settings),
        updated: canonicalizeSettings({ ...DEFAULT_SETTINGS, ...globalSettings, ...nextProjectSettings } as Settings),
      };
    });

    store.workflowStepsCache = null;
    await publishSettingsUpdated(store, result.previous, result.updated);
    return scriptCatalogFromSettings(result.updated);
  });
}
