import type { WorkflowStep } from "./types.js";
import type { WorkflowIr, WorkflowIrNode, WorkflowIrEdge } from "./workflow-ir-types.js";
import type { WorkflowNodeLayout } from "./workflow-definition-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";

/**
 * Steps → IR converter (workflow-editor-consolidation U1, R4/KTD-2).
 *
 * FNXC:WorkflowStepCRUD 2026-07-01-00:00:
 * The linear WorkflowStep compiler (`compileWorkflowToSteps` / `nodeToStepInput`)
 * was removed — the graph interpreter is the sole executor. This module survives
 * as a LEGACY LOWERING: it converts old persisted `WorkflowStep[]` rows (and
 * single-step fragments) into valid WorkflowIr for migration and for the palette
 * fragment layout. It no longer has a forward inverse, so there is no round-trip
 * parity contract; correctness is now "the produced IR is well-formed and carries
 * each step's config" (pinned by `__tests__/workflow-steps-to-ir.test.ts`).
 *
 * Each step maps to one IR node: mode "script" → kind "script" with
 * `config.scriptName`; mode "prompt" → kind "prompt" with
 * `config.prompt`/`toolMode`/`skillName`/model overrides; `config.gateMode` is
 * always written. `enabled` / `defaultOn` / `templateId` / `migratedFragmentId`
 * are handled by migration policy (KTD-3), not this converter.
 *
 * Seam encoding mirrors `linear()` in `builtin-workflows.ts` exactly: the fixed
 * execute → review → merge pipeline is emitted as prompt-kind nodes carrying
 * `config.seam`, chained by `success` edges, with each seam also wired
 * `failure → end`.
 */

/** The fixed seam pipeline, in canonical order. The `merge` seam is the
 *  pre-/post-merge boundary and is always emitted (R4). */
const SEAM_ORDER = ["execute", "review", "merge"] as const;

/** Horizontal spacing used by `linear()`; reused so migrated graphs lay out the
 *  same way built-ins do. */
const LAYOUT_X0 = 60;
const LAYOUT_DX = 170;
const LAYOUT_Y = 160;

/**
 * Lower a single `WorkflowStep` into one user IR node.
 *
 * kind ↔ mode/gateMode mapping:
 *  - mode "script" → kind "script", `config.scriptName` set.
 *  - mode "prompt" → kind "prompt", `config.prompt`/`toolMode`/`skillName`/model overrides.
 *  - gateMode is ALWAYS written to `config.gateMode` (both "gate" and "advisory").
 */
function stepInputToNode(step: WorkflowStep, id: string): WorkflowIrNode {
  const config: Record<string, unknown> = {
    name: step.name,
    // Always carry gateMode so the compiler reproduces it exactly for both modes.
    gateMode: step.gateMode,
  };
  if (step.description) config.description = step.description;

  if (step.mode === "script") {
    if (step.scriptName) config.scriptName = step.scriptName;
    return { id, kind: "script", config };
  }

  // prompt mode
  config.prompt = step.prompt ?? "";
  config.toolMode = step.toolMode === "coding" ? "coding" : "readonly";
  // Skill name round-trips when set (U1). The compiler reads it back via
  // configString(node, "skillName"), so this keeps the inverse exact.
  if (step.skillName) config.skillName = step.skillName;
  // Model overrides only round-trip when BOTH are present (compiler requirement).
  if (step.modelProvider && step.modelId) {
    config.modelProvider = step.modelProvider;
    config.modelId = step.modelId;
  }
  /*
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * A workflow step can pin reasoning effort while inheriting its model, so lower `thinkingLevel` independently from the model-provider/model-id pair.
   */
  if (step.thinkingLevel) config.thinkingLevel = step.thinkingLevel;
  return { id, kind: "prompt", config };
}

/** Build a seam node exactly as `linear()` does: a prompt-kind node tagged with
 *  `config.seam`. */
function seamNode(seam: (typeof SEAM_ORDER)[number]): WorkflowIrNode {
  return { id: seam, kind: "prompt", config: { seam } };
}

/**
 * Convert an ordered `WorkflowStep[]` into a valid v1 WorkflowIr:
 *
 *   start → [pre-merge user nodes] → execute → review → merge
 *         → [post-merge user nodes] → end
 *
 * Steps with `phase` undefined map to pre-merge (R4). Seam nodes get an extra
 * `failure → end` edge, mirroring `linear()`. The result always passes
 * `parseWorkflowIr`. An empty step list yields the minimal seam-only pipeline.
 */
export function stepsToWorkflowIr(steps: WorkflowStep[], name: string): WorkflowIr {
  const preMerge = steps.filter((s) => (s.phase ?? "pre-merge") === "pre-merge");
  const postMerge = steps.filter((s) => s.phase === "post-merge");

  const nodes: WorkflowIrNode[] = [{ id: "start", kind: "start" }];
  const userNodeIds = new Set<string>();

  // Deterministic ids that cannot collide with the reserved start/end/seam ids.
  const userNode = (step: WorkflowStep, index: number): WorkflowIrNode => {
    let id = `step-${index + 1}`;
    while (userNodeIds.has(id)) id = `${id}-x`;
    userNodeIds.add(id);
    return stepInputToNode(step, id);
  };

  preMerge.forEach((step, i) => nodes.push(userNode(step, i)));
  // Fixed execute → review → merge seam pipeline; merge is the boundary (R4).
  for (const seam of SEAM_ORDER) nodes.push(seamNode(seam));
  postMerge.forEach((step, i) => nodes.push(userNode(step, preMerge.length + i)));
  nodes.push({ id: "end", kind: "end" });

  const edges: WorkflowIrEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, condition: "success" });
  }
  // Seam nodes also fail straight to end (mirrors `linear()` / the legacy pipeline).
  for (const node of nodes) {
    if (typeof node.config?.seam === "string") {
      edges.push({ from: node.id, to: "end", condition: "failure" });
    }
  }

  return parseWorkflowIr({ version: "v1", name, nodes, edges });
}

/**
 * Convert a single `WorkflowStep` into a minimal fragment IR (R6/KTD-1):
 *
 *   start → node → end
 *
 * No seams. The node mirrors the step via `stepInputToNode`. The result passes
 * `parseWorkflowIr` and is a pure-v1 graph (survives `downgradeIrToV1IfPure`).
 */
export function stepToFragmentIr(step: WorkflowStep): WorkflowIr {
  const node = stepInputToNode(step, "step-1");
  return parseWorkflowIr({
    version: "v1",
    name: step.name,
    nodes: [{ id: "start", kind: "start" }, node, { id: "end", kind: "end" }],
    edges: [
      { from: "start", to: node.id, condition: "success" },
      { from: node.id, to: "end", condition: "success" },
    ],
  });
}

/**
 * Deterministic x-spaced layout for an IR, matching `linear()`'s geometry. Keyed
 * by node id; supply alongside the IR when persisting a `WorkflowDefinitionInput`.
 */
export function layoutForIr(ir: WorkflowIr): Record<string, WorkflowNodeLayout> {
  const layout: Record<string, WorkflowNodeLayout> = {};
  ir.nodes.forEach((node, i) => {
    layout[node.id] = { x: LAYOUT_X0 + i * LAYOUT_DX, y: LAYOUT_Y };
  });
  return layout;
}
