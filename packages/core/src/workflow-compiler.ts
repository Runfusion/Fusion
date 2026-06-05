import type { WorkflowIr, WorkflowIrNode, WorkflowIrEdge } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import type { WorkflowStepInput, WorkflowStepGateMode } from "./types.js";

/**
 * Raised when a WorkflowIr graph cannot be compiled onto the executable
 * WorkflowStep engine — typically because it branches beyond the canonical
 * seam success/failure chain and therefore requires the (deferred) graph
 * interpreter rather than the linear pre/post-merge step runner.
 */
export class WorkflowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCompileError";
  }
}

/** Seam anchor kinds, encoded on IR nodes as `config.seam`. These map to the
 *  fixed execute → review → merge pipeline and are not emitted as steps. */
const SEAM_NAMES = new Set(["execute", "review", "merge"]);

function seamOf(node: WorkflowIrNode): string | undefined {
  const seam = node.config?.seam;
  return typeof seam === "string" && SEAM_NAMES.has(seam) ? seam : undefined;
}

function configString(node: WorkflowIrNode, key: string): string | undefined {
  const value = node.config?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildOutgoing(ir: WorkflowIr): Map<string, WorkflowIrEdge[]> {
  const outgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of ir.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  return outgoing;
}

function mainEdge(edges: WorkflowIrEdge[]): WorkflowIrEdge | undefined {
  return edges.find((edge) => edge.condition !== "failure");
}

/**
 * Validate that a workflow graph reduces to a linear pre-merge → seams →
 * post-merge chain the WorkflowStep engine can run. Returns a
 * WorkflowCompileError describing the first problem, or null when compilable.
 *
 * Allowed shape: a single path from start to end. Seam nodes may carry an extra
 * `failure` edge to the end node; every other non-terminal node has exactly one
 * outgoing edge. Anything else (true branching) requires the deferred interpreter.
 */
export function validateLinearity(ir: WorkflowIr): WorkflowCompileError | null {
  const nodesById = new Map(ir.nodes.map((node) => [node.id, node]));
  for (const edge of ir.edges) {
    if (!nodesById.has(edge.from)) return new WorkflowCompileError(`edge references unknown node '${edge.from}'`);
    if (!nodesById.has(edge.to)) return new WorkflowCompileError(`edge references unknown node '${edge.to}'`);
  }

  const endNode = ir.nodes.find((node) => node.kind === "end");
  const startNode = ir.nodes.find((node) => node.kind === "start");
  if (!startNode || !endNode) {
    return new WorkflowCompileError("workflow must contain exactly one start and one end node");
  }

  const outgoing = buildOutgoing(ir);

  for (const node of ir.nodes) {
    const outs = outgoing.get(node.id) ?? [];
    if (node.kind === "end") {
      if (outs.length > 0) return new WorkflowCompileError("end node must have no outgoing edges");
      continue;
    }

    const seam = seamOf(node);
    if (seam) {
      const failureEdges = outs.filter((edge) => edge.condition === "failure");
      const mainEdges = outs.filter((edge) => edge.condition !== "failure");
      if (mainEdges.length !== 1) {
        return new WorkflowCompileError(`seam '${node.id}' must have exactly one success path`);
      }
      if (failureEdges.length > 1) {
        return new WorkflowCompileError(`seam '${node.id}' has multiple failure edges`);
      }
      if (failureEdges[0] && failureEdges[0].to !== endNode.id) {
        return new WorkflowCompileError(`seam '${node.id}' failure edge must target the end node`);
      }
      continue;
    }

    // start or a user node (prompt/script/gate): exactly one outgoing edge.
    if (outs.length === 0) {
      return new WorkflowCompileError(`node '${node.id}' has no outgoing edge`);
    }
    if (outs.length > 1) {
      // NOTE: the `require the workflow interpreter (deferred)` suffix is matched
      // by the dashboard editor (WorkflowNodeEditor handleSave, KTD-4) to render
      // an info-tone "interpreter-only" banner instead of an error. Keep both
      // interpreter-deferred messages carrying this exact suffix in sync.
      return new WorkflowCompileError(
        `node '${node.id}' branches into ${outs.length} edges — graphs with branches require the workflow interpreter (deferred)`,
      );
    }
  }

  // Reachability: the single main path must reach end and cover every node.
  // While walking, enforce the canonical seam pipeline: each of execute/review/
  // merge may appear at most once and only in that order. The compiler treats
  // seams as a fixed execute → review → merge boundary (merge flips pre- to
  // post-merge), so out-of-order or duplicate seams would compile inconsistently
  // with the runtime contract.
  const expectedSeamOrder = ["execute", "review", "merge"] as const;
  const seenSeams = new Set<string>();
  let nextExpectedSeamIndex = 0;
  const visited = new Set<string>();
  let cursor: string | undefined = startNode.id;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = nodesById.get(cursor);
    const seam = node ? seamOf(node) : undefined;
    if (seam) {
      if (seenSeams.has(seam)) {
        return new WorkflowCompileError(`seam '${seam}' appears more than once`);
      }
      while (
        nextExpectedSeamIndex < expectedSeamOrder.length &&
        expectedSeamOrder[nextExpectedSeamIndex] !== seam
      ) {
        nextExpectedSeamIndex += 1;
      }
      if (expectedSeamOrder[nextExpectedSeamIndex] !== seam) {
        return new WorkflowCompileError("seams must follow the execute -> review -> merge order");
      }
      seenSeams.add(seam);
      nextExpectedSeamIndex += 1;
    }
    if (cursor === endNode.id) break;
    cursor = mainEdge(outgoing.get(cursor) ?? [])?.to;
  }
  if (!visited.has(endNode.id)) {
    return new WorkflowCompileError("workflow main path does not reach the end node");
  }
  const unreached = ir.nodes.filter((node) => !visited.has(node.id));
  if (unreached.length > 0) {
    return new WorkflowCompileError(
      `node '${unreached[0].id}' is not on the main path — disconnected nodes require the workflow interpreter (deferred)`,
    );
  }

  return null;
}

function defaultGateMode(node: WorkflowIrNode, mode: "prompt" | "script"): WorkflowStepGateMode {
  if (node.kind === "gate") return "gate";
  const explicit = node.config?.gateMode;
  if (explicit === "gate" || explicit === "advisory") return explicit;
  return mode === "script" ? "gate" : "advisory";
}

/**
 * Map a single user IR node onto a WorkflowStepInput. This is the forward half
 * of the steps↔IR round-trip contract (workflow-editor-consolidation R4/KTD-2);
 * its exact inverse is `stepInputToNode` in `workflow-steps-to-ir.ts`. Parity is
 * pinned by `__tests__/workflow-steps-to-ir.test.ts` over exactly the
 * compiler-visible fields: name / mode / phase / gateMode / prompt / scriptName /
 * toolMode / modelProvider / modelId. `enabled` / `defaultOn` / `templateId` are
 * NOT compiler-visible and are handled by migration policy, not the converter.
 *
 * INVERSION CONTRACT: when you add a field here, extend `stepInputToNode` (and
 * the parity test) in `workflow-steps-to-ir.ts` to keep the round-trip exact.
 */
function nodeToStepInput(node: WorkflowIrNode, phase: "pre-merge" | "post-merge"): WorkflowStepInput {
  const scriptName = configString(node, "scriptName");
  const mode: "prompt" | "script" = node.kind === "script" || (node.kind === "gate" && scriptName) ? "script" : "prompt";
  const gateMode = defaultGateMode(node, mode);

  const input: WorkflowStepInput = {
    name: configString(node, "name") ?? node.id,
    description: configString(node, "description") ?? "",
    mode,
    phase,
    gateMode,
  };

  if (mode === "script") {
    input.scriptName = scriptName;
  } else {
    input.prompt = configString(node, "prompt") ?? "";
    input.toolMode = node.config?.toolMode === "coding" ? "coding" : "readonly";
    const provider = configString(node, "modelProvider");
    const modelId = configString(node, "modelId");
    if (provider && modelId) {
      input.modelProvider = provider;
      input.modelId = modelId;
    }
  }

  return input;
}

/**
 * Compile a workflow graph into an ordered list of WorkflowStep inputs ready to
 * persist and run on the existing engine. User prompt/script/gate nodes become
 * steps; execute/review seams are skipped; the merge seam is the pre-/post-merge
 * boundary. Throws WorkflowCompileError for non-linear graphs.
 *
 * The returned array order is the execution order (it maps directly onto a
 * task's `enabledWorkflowSteps`).
 */
export function compileWorkflowToSteps(ir: WorkflowIr): WorkflowStepInput[] {
  const parsed = parseWorkflowIr(ir);
  const error = validateLinearity(parsed);
  if (error) throw error;

  const nodesById = new Map(parsed.nodes.map((node) => [node.id, node]));
  const outgoing = buildOutgoing(parsed);
  const startNode = parsed.nodes.find((node) => node.kind === "start")!;

  const steps: WorkflowStepInput[] = [];
  let phase: "pre-merge" | "post-merge" = "pre-merge";
  const visited = new Set<string>();
  let cursor: string | undefined = startNode.id;

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = nodesById.get(cursor);
    if (!node) break;

    const seam = seamOf(node);
    if (seam === "merge") {
      phase = "post-merge";
    } else if (!seam && node.kind !== "start" && node.kind !== "end") {
      steps.push(nodeToStepInput(node, phase));
    }

    if (node.kind === "end") break;
    cursor = mainEdge(outgoing.get(cursor) ?? [])?.to;
  }

  return steps;
}
