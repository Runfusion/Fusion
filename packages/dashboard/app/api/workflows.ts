/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Workflow definition client API peeled from legacy.ts.
 */
import { api } from "./client.js";
import type { FetchOptions } from "./client.js";
import { withProjectId } from "./health.js";
import { dedupe } from "./dedupe.js";
import { notifyWorkflowSettingValuesUpdated } from "../utils/workflowSettingValuesEvents.js";

// ── Workflow definitions (graph-authored custom workflows) ───────────────

export type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowDefinitionUpdate,
  WorkflowIr,
} from "@fusion/core";

/** List all workflow definitions for the project. */
export function fetchWorkflows(projectId?: string, options?: { includeDisabledBuiltins?: boolean } & FetchOptions): Promise<import("@fusion/core").WorkflowDefinition[]> {
  const query = options?.includeDisabledBuiltins ? "?includeDisabledBuiltins=true" : "";
  const path = withProjectId(`/workflows${query}`, projectId);
  return dedupe(path, () => api<import("@fusion/core").WorkflowDefinition[]>(path), options);
}

/** A trait catalog entry as returned by GET /api/traits (U10). Mirrors the
 *  registry's TraitDefinition projection (flags + hook descriptors + schema). */
export interface TraitCatalogEntry {
  id: string;
  name: string;
  description?: string;
  builtin: boolean;
  flags: import("@fusion/core").TraitFlags;
  hooks?: import("@fusion/core").TraitHookDescriptors;
  configSchema?: import("@fusion/core").TraitConfigSchema;
}

/** Fetch the trait catalog (built-ins + registered plugin traits) for the
 *  workflow editor's trait picker. Registry-backed, read-only, session-scoped. */
export function fetchTraits(projectId?: string): Promise<TraitCatalogEntry[]> {
  const path = withProjectId("/traits", projectId);
  return dedupe(path, () =>
    api<{ traits: TraitCatalogEntry[] }>(path).then((res) => res.traits),
  );
}

/** Fetch the step-parser id catalog (built-ins + registered plugin parsers) for
 *  the parse-steps node inspector (KTD-12). Registry-backed, read-only,
 *  session-scoped. Mirrors fetchTraits. */
export function fetchStepParsers(projectId?: string): Promise<string[]> {
  const path = withProjectId("/step-parsers", projectId);
  return dedupe(path, () =>
    api<{ parsers: Array<{ id: string }> }>(path).then((res) => res.parsers.map((p) => p.id)),
  );
}

/** Fetch a single workflow definition. */
export function fetchWorkflow(id: string, projectId?: string): Promise<import("@fusion/core").WorkflowDefinition> {
  return api<import("@fusion/core").WorkflowDefinition>(withProjectId(`/workflows/${encodeURIComponent(id)}`, projectId));
}

/** Fetch resolved optional step declarations for a workflow. */
export function fetchWorkflowOptionalSteps(
  workflowId: string,
  projectId?: string,
): Promise<import("@fusion/core").ResolvedWorkflowOptionalStep[]> {
  return api<import("@fusion/core").ResolvedWorkflowOptionalStep[]>(
    withProjectId(`/workflows/${encodeURIComponent(workflowId)}/optional-steps`, projectId),
  );
}

/** Create a workflow definition. */
export function createWorkflow(
  input: import("@fusion/core").WorkflowDefinitionInput,
  projectId?: string,
): Promise<import("@fusion/core").WorkflowDefinition> {
  return api<import("@fusion/core").WorkflowDefinition>(withProjectId("/workflows", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a workflow definition (partial). */
export function updateWorkflow(
  id: string,
  updates: import("@fusion/core").WorkflowDefinitionUpdate,
  projectId?: string,
): Promise<import("@fusion/core").WorkflowDefinition> {
  return api<import("@fusion/core").WorkflowDefinition>(withProjectId(`/workflows/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a workflow definition. */
export function deleteWorkflow(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/workflows/${encodeURIComponent(id)}`, projectId), { method: "DELETE" });
}

/** The per-`(workflowId, project)` setting-value payload returned by the
 *  workflow setting-value endpoints (U6/R5): the raw `stored` map, the
 *  `effective` map (stored ?? declaration default, drop-on-orphan), and the
 *  `orphaned` stored entries that no longer validate against the declarations. */
export interface WorkflowSettingValuesPayload {
  stored: Record<string, unknown>;
  effective: Record<string, unknown>;
  orphaned: Array<{ id: string; value: unknown }>;
}

/** Per-project workflow prompt override payload. `defaults` is the shipped prompt
 *  by node id, `stored` is the persisted override map, and `effective` is the
 *  prompt text the editor/executor sees after stored-over-default resolution. */
export interface WorkflowPromptOverridesPayload {
  stored: Record<string, string>;
  effective: Record<string, string>;
  defaults: Record<string, string>;
}

/** Read the setting VALUES (stored/effective/orphaned) for a workflow in the
 *  current project context (U6). The project is bound server-side to the
 *  scoped store. */
export function fetchWorkflowSettingValues(
  id: string,
  projectId?: string,
): Promise<WorkflowSettingValuesPayload> {
  return api<WorkflowSettingValuesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/setting-values`, projectId),
  );
}

/** Write setting VALUES for a workflow in the current project context (U6). The
 *  `values` map is validated against the named workflow's declarations; a `null`
 *  value deletes that key. A typed rejection surfaces as an ApiRequestError with
 *  `status: 400` and `details.rejections: WorkflowSettingRejection[]`. */
export async function updateWorkflowSettingValues(
  id: string,
  values: Record<string, unknown>,
  projectId?: string,
): Promise<WorkflowSettingValuesPayload> {
  const payload = await api<WorkflowSettingValuesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/setting-values`, projectId),
    {
      method: "PATCH",
      body: JSON.stringify({ values }),
    },
  );
  if (Object.prototype.hasOwnProperty.call(values, "plannerOversightLevel")) {
    notifyWorkflowSettingValuesUpdated(id, projectId);
  }
  return payload;
}

/** Read per-node prompt overrides for a workflow in the current project context. */
export function fetchWorkflowPromptOverrides(
  id: string,
  projectId?: string,
): Promise<WorkflowPromptOverridesPayload> {
  return api<WorkflowPromptOverridesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/prompt-overrides`, projectId),
  );
}

/** Patch per-node prompt overrides. Null, empty, and whitespace values reset to the shipped default. */
export function updateWorkflowPromptOverrides(
  id: string,
  overrides: Record<string, string | null>,
  projectId?: string,
): Promise<WorkflowPromptOverridesPayload> {
  return api<WorkflowPromptOverridesPayload>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/prompt-overrides`, projectId),
    {
      method: "PATCH",
      body: JSON.stringify({ overrides }),
    },
  );
}

/** A workflow export envelope (U5/R9/KTD-5). `schemaVersion` is the SERVER's
 *  schema version at export time — the import route version-gates against it
 *  (the app build aliases @fusion/core to types-only, so the value can only come
 *  from the server, never an app-side core import).
 *
 *  FNXC:WorkflowPortability 2026-06-30-00:00:
 *  Dashboard downloads must carry project-scoped setting values and prompt overrides with the workflow graph so the same shared API path supports portable desktop and mobile Workflow Editor imports.
 */
export interface WorkflowExportEnvelope {
  fusionWorkflowExport: 1;
  schemaVersion: number;
  kind: import("@fusion/core").WorkflowDefinition["kind"];
  name: string;
  description: string;
  ir: import("@fusion/core").WorkflowIr;
  layout: import("@fusion/core").WorkflowDefinition["layout"];
  settingValues: Record<string, unknown>;
  promptOverrides: Record<string, string>;
}

/** Fetch a workflow's export envelope and trigger a browser download as
 *  `<name>.workflow.json` (U5/R9). Built-ins are exportable too. Mirrors the
 *  SettingsModal export pattern (Blob + createObjectURL + a.download). */
export async function exportWorkflow(id: string, projectId?: string): Promise<WorkflowExportEnvelope> {
  const envelope = await api<WorkflowExportEnvelope>(
    withProjectId(`/workflows/${encodeURIComponent(id)}/export`, projectId),
  );
  const safeName = (envelope.name || "workflow").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}.workflow.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return envelope;
}

/** Result of POST /api/workflows/import (U5/R10). `strippedApprovalFlags` is set
 *  when `cliSkipApproval`/`autoApprove` were removed from any node config at the
 *  trust boundary; `warnings` lists non-blocking issues (e.g. unknown scriptName). */
export interface ImportWorkflowResult {
  workflow: import("@fusion/core").WorkflowDefinition;
  strippedApprovalFlags: boolean;
  warnings: string[];
  settingValues: Record<string, unknown>;
  promptOverrides: Record<string, string>;
}

/** Import a workflow export envelope (U5/R10). The server is the sole validator;
 *  validation failures reject with an ApiError carrying the server message. */
export function importWorkflow(
  envelope: unknown,
  projectId?: string,
): Promise<ImportWorkflowResult> {
  return api<ImportWorkflowResult>(withProjectId("/workflows/import", projectId), {
    method: "POST",
    body: JSON.stringify(envelope),
  });
}

// FNXC:WorkflowStepCRUD 2026-06-26-14:00: U7c removed migrateLegacyWorkflowSteps and
// MigrateLegacyStepsResult along with the legacy workflow_steps table and its route.

/** Result of POST /api/workflows/design (U10/R11). The server validates the
 *  AI-produced IR (parseWorkflowIr) and strips trust-escalating flags
 *  (`strippedApprovalFlags`). Persists nothing — the client decides what to do
 *  with the returned graph. */
export interface DesignWorkflowResult {
  ir: import("@fusion/core").WorkflowIr;
  layout: import("@fusion/core").WorkflowDefinition["layout"];
  strippedApprovalFlags: boolean;
}

/** Design a workflow from a natural-language prompt (U10/R11). When `workflowId`
 *  is supplied the route reads that workflow's persisted IR server-side and folds
 *  it into the prompt as the base graph (the client never posts IR). An optional
 *  AbortSignal cancels the in-flight request. Validation failures reject with an
 *  ApiError carrying the server message; 429 on rate limit. */
export function designWorkflow(
  input: { prompt: string; workflowId?: string },
  projectId?: string,
  signal?: AbortSignal,
): Promise<DesignWorkflowResult> {
  return api<DesignWorkflowResult>(withProjectId("/workflows/design", projectId), {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

/** Read the workflow currently selected for a task. */
export function fetchTaskWorkflow(taskId: string, projectId?: string): Promise<{ workflowId: string | null; enabledWorkflowSteps?: string[] | null }> {
  return api<{ workflowId: string | null; enabledWorkflowSteps?: string[] | null }>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow`, projectId),
  );
}

/** Select (or clear, with null) a workflow for a task. Returns the resulting
 *  enabled step ids so callers can reflect the change without a refetch. */
export function selectTaskWorkflow(
  taskId: string,
  workflowId: string | null,
  projectId?: string,
): Promise<{
  workflowId: string | null;
  enabledWorkflowSteps: string[];
  // U5 (R20): present (flag ON) when the switch re-homed the card; `preserved`
  // false means the card moved columns and the board needs a refresh.
  reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
}> {
  return api<{
    workflowId: string | null;
    enabledWorkflowSteps: string[];
    reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
  }>(
    withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow`, projectId),
    {
      method: "PUT",
      body: JSON.stringify({ workflowId }),
    },
  );
}

/** Approve the raw CLI command a task is paused on, and resume it. */
export function approveTaskWorkflowCli(taskId: string, projectId?: string): Promise<{ approved: string }> {
  return api<{ approved: string }>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow/approve-cli`, projectId), {
    method: "POST",
  });
}

/** Submit the user's answer to an await-input node and resume the task. */
export function submitTaskWorkflowInput(taskId: string, text: string, projectId?: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(withProjectId(`/tasks/${encodeURIComponent(taskId)}/workflow/input`, projectId), {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/** Read the project default workflow. */
export function fetchProjectDefaultWorkflow(projectId?: string): Promise<{ workflowId: string | null }> {
  return api<{ workflowId: string | null }>(withProjectId("/project/default-workflow", projectId));
}

/** Set (or clear, with null) the project default workflow. */
export function setProjectDefaultWorkflow(
  workflowId: string | null,
  projectId?: string,
): Promise<{ workflowId: string | null }> {
  return api<{ workflowId: string | null }>(withProjectId("/project/default-workflow", projectId), {
    method: "PUT",
    body: JSON.stringify({ workflowId }),
  });
}

// ── Workflow Step Templates ──────────────────────────────────────────────

/** Re-export WorkflowStepTemplate type from core */
export type { WorkflowStepTemplate } from "@fusion/core";

/** Fetch the workflow step templates that feed the editor palette. The built-in
 *  built-in step-template catalog was deleted in U6, so this now returns only
 *  plugin-contributed templates. */
export function fetchWorkflowStepTemplates(): Promise<{ templates: import("@fusion/core").WorkflowStepTemplate[] }> {
  return api<{ templates: import("@fusion/core").WorkflowStepTemplate[] }>("/workflow-step-templates");
}

/** Fetch plugin-contributed workflow step templates */
export function fetchPluginWorkflowStepTemplates(): Promise<{
  templates: Array<{ pluginId: string; template: import("@fusion/core").WorkflowStepTemplate }>;
}> {
  return api<{
    templates: Array<{ pluginId: string; template: import("@fusion/core").WorkflowStepTemplate }>;
  }>("/plugin-workflow-step-templates");
}

// ── Scripts API ────────────────────────────────────────────────────────

/** Script entry returned from the API */
export interface ScriptEntry {
  name: string;
  command: string;
}

/** Result of running a script via POST /api/scripts/:name/run */
export interface ScriptRunResult {
  sessionId: string;
  command: string;
}

/** Fetch all saved scripts from project settings */
export function fetchScripts(projectId?: string): Promise<Record<string, string>> {
  return api<Record<string, string>>(withProjectId("/scripts", projectId));
}

/** Add or update a script */
export function addScript(name: string, command: string, projectId?: string): Promise<ScriptEntry> {
  return api<ScriptEntry>(withProjectId("/scripts", projectId), {
    method: "POST",
    body: JSON.stringify({ name, command }),
  });
}

/** Remove a script by name */
export function removeScript(name: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/scripts/${encodeURIComponent(name)}`, projectId), { method: "DELETE" });
}

/** Run a saved script by name */
export function runScript(name: string, args?: string[], projectId?: string): Promise<ScriptRunResult> {
  return api<ScriptRunResult>(withProjectId(`/scripts/${encodeURIComponent(name)}/run`, projectId), {
    method: "POST",
    body: JSON.stringify({ args }),
  });
}

