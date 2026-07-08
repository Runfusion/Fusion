/**
 * Board multi-lane payload assembly (U9, R16/R17).
 *
 * When the `workflowColumns` flag is ON, the dashboard board groups visible
 * cards into one lane per workflow in use. This module resolves, for a set of
 * tasks, the workflow each card belongs to plus the (deduplicated) set of
 * workflow definitions referenced — each carrying its ordered columns, display
 * names, and *resolved trait flags* (archived / hold / complete / wip etc.) so
 * the client can render lanes, hide archived columns, show promote affordances,
 * and pre-check drag adjacency/capacity without a second round-trip.
 *
 * The payload is served by a sibling endpoint (`GET /tasks/board-workflows`)
 * rather than folded into the `/tasks` list response, so the existing task
 * payload stays byte-identical and flag-OFF clients are wholly unaffected
 * (additive-only, KTD-8/R19).
 */

import {
  BUILTIN_CODING_WORKFLOW_IR,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
  isWorkflowColumnsEnabled,
  parseWorkflowIr,
  resolveColumnFlags,
  resolveWorkflowIrById,
  type Settings,
  type TaskStore,
  type TraitFlags,
  type WorkflowIr,
  type WorkflowIrV2,
  type WorkflowFieldDefinition,
} from "@fusion/core";

/** A workflow-defined custom task field as the board client needs it (U13/KTD-14).
 *  Uses @fusion/core's WorkflowFieldDefinition directly now that it is exported
 *  through the barrel. The payload is a verbatim pass-through of the IR's `fields` array. */
export type BoardWorkflowField = WorkflowFieldDefinition;

/** Stable id the client uses for the implicit default lane (null selection). */
export const DEFAULT_WORKFLOW_LANE_ID = "builtin:coding";

/** One column as the board client needs it: id, display name, resolved flags. */
export interface BoardWorkflowColumn {
  id: string;
  name: string;
  flags: TraitFlags;
}

/** A workflow definition in use by visible cards. */
export interface BoardWorkflowDefinition {
  id: string;
  name: string;
  /** Optional compact custom workflow icon; built-ins render the Fusion mark by id. */
  icon?: string;
  columns: BoardWorkflowColumn[];
  /** Custom field definitions declared by the workflow (U13/KTD-14). Absent
   *  when the workflow declares no fields. */
  fields?: BoardWorkflowField[];
}

/** The full board-workflows payload. `flagEnabled: false` short-circuits the
 *  client back to the legacy single-lane render. */
export interface BoardWorkflowsPayload {
  flagEnabled: boolean;
  /** The default lane id (where null-selection cards land). */
  defaultWorkflowId: string;
  /** Deduplicated workflow definitions referenced by the provided tasks. */
  workflows: BoardWorkflowDefinition[];
  /** taskId → resolved workflowId (the lane the card belongs in). */
  taskWorkflowIds: Record<string, string>;
}

/*
 * FNXC:Workflows 2026-07-07-00:00:
 * The canonical built-in lifecycle label for the intake column (id: "triage")
 * is "Planning" — FN-7599 renamed the IR column name, but this override map
 * was still clobbering it back to "Triage" for built-in workflows via
 * describeColumns(ir, true). Do not re-clobber the IR rename (FN-7660); the
 * column id itself remains "triage" everywhere (types, DB, transitions).
 */
const BUILTIN_WORKFLOW_COLUMN_LABELS: Record<string, string> = {
  ideas: "Ideas",
  triage: "Planning",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  archived: "Archived",
};

function toV2(ir: WorkflowIr): WorkflowIrV2 | undefined {
  return ir.version === "v2" ? ir : undefined;
}

function displayColumnName(id: string, name: string, canonicalizeLifecycle: boolean): string {
  if (!canonicalizeLifecycle) return name;
  return BUILTIN_WORKFLOW_COLUMN_LABELS[id] ?? name;
}

function describeColumns(ir: WorkflowIr, canonicalizeLifecycle = false): BoardWorkflowColumn[] {
  const v2 = toV2(ir);
  if (!v2) return [];
  return v2.columns.map((col) => ({
    id: col.id,
    name: displayColumnName(col.id, col.name, canonicalizeLifecycle),
    flags: resolveColumnFlags(col),
  }));
}

/** Pass through the workflow's declared custom fields (U13/KTD-14). Returns
 *  `undefined` when the workflow declares none, so the payload stays compact and
 *  byte-identical for field-less workflows. */
function describeFields(ir: WorkflowIr): BoardWorkflowField[] | undefined {
  const v2 = toV2(ir);
  const fields = v2?.fields;
  if (!fields || fields.length === 0) return undefined;
  return fields;
}

async function describeWorkflow(
  store: Pick<TaskStore, "getWorkflowDefinition">,
  workflowId: string,
): Promise<BoardWorkflowDefinition> {
  // The display name comes from the persisted definition when available,
  // otherwise the IR's own name (default workflow).
  if (isBuiltinWorkflowId(workflowId)) {
    const ir = await resolveWorkflowIrById(store, workflowId);
    const name = getBuiltinWorkflow(workflowId)?.name ?? ir.name;
    const fields = describeFields(ir);
    return { id: workflowId, name, columns: describeColumns(ir, true), ...(fields ? { fields } : {}) };
  }
  // Custom workflow: fetch the definition once and derive both IR and name from
  // it (previously getWorkflowDefinition was called twice per workflow).
  let ir: WorkflowIr = BUILTIN_CODING_WORKFLOW_IR;
  let name = ir.name;
  let icon: string | undefined;
  try {
    const def = await store.getWorkflowDefinition(workflowId);
    if (def) {
      ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
      name = def.name || ir.name;
      icon = def.icon;
    }
  } catch {
    // fall through to the default IR/name
  }
  const fields = describeFields(ir);
  return { id: workflowId, name, ...(icon ? { icon } : {}), columns: describeColumns(ir), ...(fields ? { fields } : {}) };
}

/**
 * Build the board-workflows payload for the given task ids. Resolves each task's
 * workflow selection (null → the default workflow lane) and assembles the
 * deduplicated set of referenced workflow definitions. Returns
 * `{ flagEnabled: false, ... }` (empty maps) when the flag is OFF so the route
 * can return early and the client renders the legacy board.
 */
export async function buildBoardWorkflowsPayload(
  store: Pick<TaskStore, "getWorkflowDefinition" | "getTaskWorkflowSelection" | "getSettings" | "listWorkflowDefinitions">,
  taskIds: string[],
  settingsOverride?: Pick<Settings, "experimentalFeatures">,
): Promise<BoardWorkflowsPayload> {
  const settings = settingsOverride ?? (await store.getSettings());
  const flagEnabled = isWorkflowColumnsEnabled(settings);

  const empty: BoardWorkflowsPayload = {
    flagEnabled,
    defaultWorkflowId: DEFAULT_WORKFLOW_LANE_ID,
    workflows: [],
    taskWorkflowIds: {},
  };
  if (!flagEnabled) return empty;

  const taskWorkflowIds: Record<string, string> = {};
  const referenced = new Set<string>();

  for (const taskId of taskIds) {
    let workflowId = DEFAULT_WORKFLOW_LANE_ID;
    try {
      const selection = store.getTaskWorkflowSelection(taskId);
      if (selection?.workflowId) workflowId = selection.workflowId;
    } catch {
      workflowId = DEFAULT_WORKFLOW_LANE_ID;
    }
    taskWorkflowIds[taskId] = workflowId;
    referenced.add(workflowId);
  }

  // The default workflow lane is always describable so a no-task board still
  // resolves it (and the client's default-lane-first ordering is stable).
  referenced.add(DEFAULT_WORKFLOW_LANE_ID);

  try {
    const definitions = await store.listWorkflowDefinitions();
    for (const definition of definitions) {
      if (definition.kind === "fragment") continue;
      referenced.add(definition.id);
    }
  } catch (err) {
    // Older/partial test stores may not expose definition listing; the referenced
    // workflow set above is still sufficient for task rendering. Production
    // failures are logged so empty workflow definitions do not disappear silently.
    console.warn("[board-workflows] listWorkflowDefinitions failed; using referenced workflows only", err);
  }

  const workflows: BoardWorkflowDefinition[] = [];
  for (const workflowId of referenced) {
    workflows.push(await describeWorkflow(store, workflowId));
  }

  return {
    flagEnabled,
    defaultWorkflowId: DEFAULT_WORKFLOW_LANE_ID,
    workflows,
    taskWorkflowIds,
  };
}
