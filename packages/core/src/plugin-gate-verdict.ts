/**
 * Pre-evaluated plugin gate verdicts (U8, KTD-2).
 *
 * Per KTD-2 a plugin gate is evaluated *before* the move is attempted, OUTSIDE
 * the task lock (via the prompt-session/script/verdict machinery). The verdict
 * is recorded and then re-checked cheaply IN-LOCK at move time — this removes
 * any path where plugin code can block or wedge the task lock.
 *
 * The engine (PluginRunner trait adapter) evaluates the gate and records the
 * verdict through `TaskStore.recordPluginGateVerdict`; the flag-ON guard site in
 * `moveTaskInternal` consumes it through `consumePluginGateVerdicts` and rejects
 * the move when a blocking gate has no recorded `allow` verdict.
 *
 * U8 keeps the storage minimal and surgical (an in-memory map on the store) per
 * the unit's "define it here minimally" note. The shape below is the seam a
 * later unit can back with SQLite without changing call sites.
 */

import type { WorkflowIr, WorkflowIrV2, WorkflowIrColumn } from "./workflow-ir-types.js";
import type { TraitDefinition } from "./trait-types.js";

/** A recorded gate verdict for a (task, targetColumn, trait). */
export interface PluginGateVerdict {
  /** The registry-facing trait id (e.g. `plugin:<pluginId>:<traitId>`). */
  traitId: string;
  /** Whether the gate verdict allows the move into the target column. */
  allow: boolean;
  /** `blocking` fails closed on a non-allow verdict; `advisory` records+allows. */
  gateMode: "blocking" | "advisory";
  /** Human-readable detail surfaced in the rejection / audit. */
  detail?: string;
  /** When the verdict was recorded (epoch ms). */
  recordedAt: number;
}

/** A plugin gate trait found on a column (id + its declared gate mode). */
export interface ColumnPluginGate {
  /** The column trait's registry id. */
  traitId: string;
  /** Gate mode from the column trait's `config.gateMode` (defaults to blocking). */
  gateMode: "blocking" | "advisory";
}

/** Resolve a workflow column by id from a (v2) IR, or undefined. */
export function findWorkflowColumn(
  ir: WorkflowIr,
  columnId: string,
): WorkflowIrColumn | undefined {
  const v2 = ir as WorkflowIrV2;
  if (!Array.isArray(v2.columns)) return undefined;
  return v2.columns.find((c) => c.id === columnId);
}

/**
 * Identify the PLUGIN gate traits on a target column. A trait qualifies when:
 *   - its registry id is namespaced (`plugin:...`) — built-in gate traits are
 *     handled by the built-in gate path, not this plugin-facing surface; AND
 *   - it actually declares a gate (a `gate` hook descriptor or the `gate` flag),
 *     resolved via `lookupTrait`. A plugin trait with only onEnter/onExit/etc.
 *     is NOT a gate and must not demand a verdict.
 *
 * The gate mode is read from the column trait's `config.gateMode` (defaults to
 * blocking, matching the built-in gate's fail-closed posture).
 */
export function resolveColumnPluginGates(
  column: WorkflowIrColumn | undefined,
  lookupTrait?: (traitId: string) => TraitDefinition | undefined,
): ColumnPluginGate[] {
  if (!column) return [];
  const gates: ColumnPluginGate[] = [];
  for (const ct of column.traits) {
    if (!ct.trait.startsWith("plugin:")) continue;
    const def = lookupTrait?.(ct.trait);
    // When a lookup is supplied, require the trait to actually declare a gate.
    // Without a lookup (no registry access) we fall back to treating any plugin
    // trait as a potential gate — the conservative fail-closed default.
    if (lookupTrait && !(def?.hooks?.gate || def?.flags?.gate)) continue;
    const cfgMode = ct.config?.gateMode;
    const gateMode = cfgMode === "advisory" ? "advisory" : "blocking";
    gates.push({ traitId: ct.trait, gateMode });
  }
  return gates;
}
