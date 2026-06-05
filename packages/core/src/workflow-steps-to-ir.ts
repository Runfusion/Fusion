import type { WorkflowStep } from "./types.js";
import type { WorkflowIr, WorkflowIrNode, WorkflowIrEdge } from "./workflow-ir-types.js";
import type { WorkflowNodeLayout } from "./workflow-definition-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";

/**
 * Steps → IR converter (workflow-editor-consolidation U1, R4/KTD-2).
 *
 * This module is the exact INVERSE of the compiler's `nodeToStepInput`
 * (`workflow-compiler.ts`). The round-trip contract is:
 *
 *   compileWorkflowToSteps(stepsToWorkflowIr(steps, name)) ≡ steps
 *
 * over exactly the compiler-visible fields: name / mode / phase / gateMode /
 * prompt / scriptName / toolMode / modelProvider / modelId. `enabled` /
 * `defaultOn` / `templateId` / `migratedFragmentId` are NOT compiler-visible and
 * are handled by migration policy (KTD-3), not by this converter. Parity is
 * pinned by `__tests__/workflow-steps-to-ir.test.ts`.
 *
 * INVERSION CONTRACT: when a compiler-visible field is added to `nodeToStepInput`
 * (see the contract comment there), extend `stepInputToNode` below and the parity
 * test to keep the round-trip exact.
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
 * Inverse of `nodeToStepInput` (workflow-compiler.ts). Produces a single user IR
 * node whose forward compilation reproduces every compiler-visible field of the
 * given step.
 *
 * kind ↔ mode/gateMode mapping (the heart of the contract):
 *  - mode "script" → kind "script", `config.scriptName` set. The compiler reads
 *    mode from `kind === "script"`, so this round-trips to mode "script".
 *  - mode "prompt" → kind "prompt", `config.prompt`/`toolMode`/model overrides.
 *  - gateMode is ALWAYS written to `config.gateMode` (both "gate" and "advisory").
 *    The compiler's `defaultGateMode` returns an explicit `config.gateMode` for
 *    non-gate-kind nodes verbatim, so this round-trips for both modes without
 *    needing the `gate` node kind (which the compiler only emits via scriptName
 *    heuristics — using explicit `config.gateMode` keeps the inverse total).
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
  // Model overrides only round-trip when BOTH are present (compiler requirement).
  if (step.modelProvider && step.modelId) {
    config.modelProvider = step.modelProvider;
    config.modelId = step.modelId;
  }
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
 * `parseWorkflowIr`. An empty step list yields the minimal seam-only pipeline
 * (which compiles back to `[]`).
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
