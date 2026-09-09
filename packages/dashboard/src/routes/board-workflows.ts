import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-board-workflows");
/**
 * Board multi-lane payload assembly (U9, R16/R17).
 *
 * When the `workflowColumns` flag is ON, the dashboard board groups visible
 * cards into one lane per workflow in use. This module resolves, for a set of
 * tasks, the workflow each card belongs to plus the (deduplicated) set of
 * workflow definitions referenced — each carrying its ordered columns, display
 * names, and *resolved trait flags* (archived / hold / complete / wip etc.) so
 * the client can render live lanes and show promote affordances,
 * and pre-check drag adjacency/capacity without a second round-trip.
 *
 * The payload is served by a sibling endpoint (`GET /tasks/board-workflows`)
 * rather than folded into the `/tasks` list response, so the existing task
 * payload stays byte-identical and flag-OFF clients are wholly unaffected
 * (additive-only, KTD-8/R19).
 */

import {
  resolveDefaultWorkflowIr,
  resolveEffectiveDefaultWorkflowId,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
  parseWorkflowIr,
  resolveAllowedColumns,
  resolveColumnFlags,
  resolveWorkflowIrById,
  type Settings,
  type TaskStore,
  type TraitFlags,
  type WorkflowIr,
  type WorkflowIrV2,
  type WorkflowIrColumn,
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
  /** Optional author-defined explanatory copy; omitted keeps client lifecycle fallback. */
  description?: string;
  flags: TraitFlags;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
  The columns this one may move to, resolved from the workflow's OWN graph adjacency
  (`resolveAllowedColumns`) — the same function `moveTaskInternal` validates against,
  so the menu offers exactly what the store will accept.

  This field exists to retire the client's two remaining legacy-vocabulary reads. The
  context menu previously had no adjacency at all, so it approximated targets by a
  column's NEIGHBOURS in declared order and kept a `VALID_TRANSITIONS` shortcut for
  workflows whose column-id set matched the six built-ins — because the neighbour
  approximation is strictly weaker (in-progress: 4 real targets vs 2 neighbours).

  Optional on the wire so a client older than this field keeps its previous behaviour
  rather than losing its move menu.
  */
  moveTargets?: string[];
}

/** A workflow definition in use by visible cards. */
export interface BoardWorkflowDefinition {
  id: string;
  name: string;
  /** Whether this definition may be selected for new board/task work. Optional for older cached payloads. */
  selectable?: boolean;
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
};

function toV2(ir: WorkflowIr): WorkflowIrV2 | undefined {
  return ir.version === "v2" ? ir : undefined;
}

/*
 * FNXC:WorkflowResolvedColumns 2026-07-27-16:45 (U10 / R8):
 * The canonical map is a FALLBACK, not an override. Applied unconditionally it replaced the name
 * a built-in workflow deliberately chose — `builtin:lead-generation` names `triage` "Lead intake"
 * and the board rendered "Planning" — and it is the same mechanism that would clobber a renamed
 * built-in column (U11's Todo -> Planning). Canonicalise only when the IR's own name adds nothing:
 * blank, the raw column id, or the same words in different case (the "In progress"/"In Progress"
 * variants that motivated the map). Anything else is an authored name and wins.
 */
function displayColumnName(id: string, name: string, canonicalizeLifecycle: boolean): string {
  if (!canonicalizeLifecycle) return name;
  const canonical = BUILTIN_WORKFLOW_COLUMN_LABELS[id];
  if (!canonical) return name;
  const trimmed = name?.trim() ?? "";
  const isUninformative = trimmed === ""
    || trimmed.toLowerCase() === id.toLowerCase()
    || trimmed.toLowerCase() === canonical.toLowerCase();
  return isUninformative ? canonical : trimmed;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
`manualIntake` — an intake column that does NOT auto-triage, i.e. one where cards wait
for an operator to promote them (Coding (Ideas)'s "Ideas" lane).

It exists because the distinction is trait CONFIG (`intake` with `autoTriage: false`),
not a trait flag, so it was invisible to every client. The dashboard approximated it as
`intake && column !== "triage"` — a hardcoded id doing the work of a missing fact. That
approximation inverts under U11: the merged Planning column keeps id `todo` and `triage`
is deleted, so `column !== "triage"` becomes vacuously TRUE and a "Start" action would
appear on every planning card. Surfacing the real fact is the fix; renaming the
comparison would not have been.
*/
function isManualIntakeColumn(col: WorkflowIrColumn): boolean {
  const flags = resolveColumnFlags(col);
  if (flags.intake !== true) return false;
  const intakeTrait = (col.traits ?? []).find((trait) => trait.trait === "intake");
  return (intakeTrait?.config as { autoTriage?: boolean } | undefined)?.autoTriage === false;
}

function describeColumns(ir: WorkflowIr, canonicalizeLifecycle = false): BoardWorkflowColumn[] {
  const v2 = toV2(ir);
  if (!v2) return [];
  return v2.columns.map((col) => ({
    id: col.id,
    name: displayColumnName(col.id, col.name, canonicalizeLifecycle),
    ...(col.description ? { description: col.description } : {}),
    flags: { ...resolveColumnFlags(col), ...(isManualIntakeColumn(col) ? { manualIntake: true } : {}) },
    moveTargets: resolveAllowedColumns(ir, col.id),
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
  selectable: boolean,
): Promise<BoardWorkflowDefinition> {
  // The display name comes from the persisted definition when available,
  // otherwise the IR's own name (default workflow).
  if (isBuiltinWorkflowId(workflowId)) {
    const ir = await resolveWorkflowIrById(store, workflowId);
    const name = getBuiltinWorkflow(workflowId)?.name ?? ir.name;
    const fields = describeFields(ir);
    return { id: workflowId, name, selectable, columns: describeColumns(ir, true), ...(fields ? { fields } : {}) };
  }
  // Custom workflow: fetch the definition once and derive both IR and name from
  // it (previously getWorkflowDefinition was called twice per workflow).
  /*
  FNXC:WorkflowBuiltins 2026-07-31-23:59:
  THE CATALOG DEFAULT, NOT THE LEGACY IR. This is the placeholder a CUSTOM workflow's description
  falls back to when `getWorkflowDefinition` returns nothing or throws.
  `BUILTIN_CODING_WORKFLOW_IR` is `builtin:legacy-coding`, which declares a `triage` column the
  default board does not have — so a workflow that failed to load was described with a phantom lane.
  That is the #3178 symptom (TUI board rendering `triage`) reached through the dashboard route.
  */
  let ir: WorkflowIr = resolveDefaultWorkflowIr();
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
  return { id: workflowId, name, selectable, ...(icon ? { icon } : {}), columns: describeColumns(ir), ...(fields ? { fields } : {}) };
}

/**
 * Build the board-workflows payload for the given task ids. Resolves each task's
 * workflow selection (null → the default workflow lane) and assembles the
 * deduplicated set of referenced workflow definitions.
 *
 * FNXC:WorkflowColumns 2026-07-27-09:48 (U2 / R9):
 * The flag-OFF early return is deleted — its gate (`isWorkflowColumnsEnabled`)
 * returned a literal `true`, so the empty payload was unreachable. `flagEnabled`
 * stays on the WIRE as a constant `true` because shipped dashboard clients still
 * branch on it (Board, ListView, TaskDetailModal, useBoardWorkflows); removing
 * the field would change the response shape, which this delete-only unit must
 * not do. U10 retires the field once no client reads it.
 */
export async function buildBoardWorkflowsPayload(
  store: Pick<TaskStore, "getWorkflowDefinition" | "getTaskWorkflowSelection" | "getSettings" | "listWorkflowDefinitions"> &
    Partial<Pick<TaskStore, "getTaskWorkflowSelectionAsync">>,
  taskIds: string[],
  settingsOverride?: Pick<Settings, "experimentalFeatures">,
): Promise<BoardWorkflowsPayload> {
  /*
  FNXC:WorkflowColumns 2026-07-27-09:50 (U2 / R9):
  `settingsOverride` and the `store.getSettings()` read it defaulted to existed
  ONLY to feed the deleted flag check — no other field of this payload depends on
  settings. The parameter stays in the signature (callers pass it positionally
  and it costs nothing) but is no longer read, so the settings round-trip is gone
  from the board-load path.
  */
  void settingsOverride;
  const flagEnabled = true;
  let settings: Pick<Settings, "defaultWorkflowId" | "enabledBuiltinWorkflowIds"> = {};
  try {
    const loaded = await store.getSettings();
    if (loaded) settings = loaded;
  } catch {
    // A degraded settings read still permits explicit task assignments to render.
  }
  /*
  FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
  Board metadata uses the same effective default as task creation. The catalog
  Coding id is only the fallback identity; it is never injected when project
  enablement has selected another built-in.
  */
  const defaultWorkflowId = resolveEffectiveDefaultWorkflowId(
    settings.defaultWorkflowId,
    settings.enabledBuiltinWorkflowIds,
  );

  const taskWorkflowIds: Record<string, string> = {};
  const referenced = new Set<string>();
  const selectableWorkflowIds = new Set<string>([defaultWorkflowId]);

  for (const taskId of taskIds) {
    let workflowId = defaultWorkflowId;
    try {
      const selection = store.getTaskWorkflowSelectionAsync
        ? await store.getTaskWorkflowSelectionAsync(taskId)
        : store.getTaskWorkflowSelection(taskId);
      if (selection?.workflowId) workflowId = selection.workflowId;
    } catch {
      workflowId = defaultWorkflowId;
    }
    taskWorkflowIds[taskId] = workflowId;
    referenced.add(workflowId);
  }

  // The effective default is always describable so a no-task board still
  // resolves it and the client has one authoritative selectable lane.
  referenced.add(defaultWorkflowId);

  try {
    const definitions = await store.listWorkflowDefinitions();
    for (const definition of definitions) {
      if (definition.kind === "fragment") continue;
      selectableWorkflowIds.add(definition.id);
      referenced.add(definition.id);
    }
  } catch (err) {
    // Older/partial test stores may not expose definition listing; the referenced
    // workflow set above is still sufficient for task rendering. Production
    // failures are logged so empty workflow definitions do not disappear silently.
    severityAuditLog.warn("[board-workflows] listWorkflowDefinitions failed; using referenced workflows only", err);
  }

  const workflows: BoardWorkflowDefinition[] = [];
  for (const workflowId of referenced) {
    workflows.push(await describeWorkflow(store, workflowId, selectableWorkflowIds.has(workflowId)));
  }

  return {
    flagEnabled,
    defaultWorkflowId,
    workflows,
    taskWorkflowIds,
  };
}
