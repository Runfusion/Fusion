import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "./builtin-stepwise-coding-workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import type { WorkflowDefinition } from "./workflow-definition-types.js";
import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";

/** Prefix marking a workflow as a read-only built-in template. */
export const BUILTIN_WORKFLOW_ID_PREFIX = "builtin:";

export function isBuiltinWorkflowId(id: string): boolean {
  return id.startsWith(BUILTIN_WORKFLOW_ID_PREFIX);
}

// Stable timestamp so built-ins round-trip deterministically.
const BUILTIN_TS = "2026-01-01T00:00:00.000Z";

interface BuiltinSpec {
  id: string;
  name: string;
  description: string;
  /** Ordered node specs between start and end; seams use {seam}. */
  nodes: Array<{ id: string; kind: WorkflowIr["nodes"][number]["kind"]; config?: Record<string, unknown> }>;
}

/** Build a linear IR (start → nodes… → end) with simple x-spaced layout. */
function linear(spec: BuiltinSpec): WorkflowDefinition {
  const nodes: WorkflowIr["nodes"] = [
    { id: "start", kind: "start" },
    ...spec.nodes,
    { id: "end", kind: "end" },
  ];
  const edges: WorkflowIr["edges"] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, condition: "success" });
  }
  // Seam nodes also fail straight to end (mirrors the legacy pipeline).
  for (const node of spec.nodes) {
    if (typeof node.config?.seam === "string") {
      edges.push({ from: node.id, to: "end", condition: "failure" });
    }
  }
  const layout: Record<string, { x: number; y: number }> = {};
  nodes.forEach((node, i) => {
    layout[node.id] = { x: 60 + i * 170, y: 160 };
  });
  const ir = parseWorkflowIr({ version: "v1", name: spec.name, nodes, edges });
  // Attach the moved-key settings catalog (U1/U3, R4) so every built-in workflow
  // carries its declarations through the resolver path (resolveWorkflowIrById →
  // resolveEffectiveSettings). v1 graphs upgrade to v2 on parse, so the parsed IR
  // is v2 and can carry `settings`. Defaults are byte-equal to legacy
  // DEFAULT_PROJECT_SETTINGS literals, so this is behavior-inert.
  if (ir.version === "v2") {
    ir.settings = BUILTIN_WORKFLOW_SETTINGS;
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    // Built-ins are always selectable workflows, never fragments (KTD-1).
    kind: "workflow",
    ir,
    layout,
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  };
}

/**
 * Read-only built-in workflow templates. Selectable like any workflow; they
 * cannot be edited or deleted. In compile mode (flag off) only the custom
 * prompt/script/gate nodes become WorkflowSteps; the execute/review/merge
 * seams are honored only by the graph interpreter (flag on).
 */
export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  linear({
    id: "builtin:coding",
    name: "Coding (built-in)",
    description: "The standard coding pipeline: implement, review, then merge. Equivalent to the default behavior.",
    nodes: [
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "review", kind: "prompt", config: { seam: "review" } },
      { id: "merge", kind: "prompt", config: { seam: "merge" } },
    ],
  }),
  linear({
    id: "builtin:quick-fix",
    name: "Quick fix (built-in)",
    description: "Implement and merge with no review step — for trivial, low-risk changes.",
    nodes: [
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "merge", kind: "prompt", config: { seam: "merge" } },
    ],
  }),
  linear({
    id: "builtin:review-heavy",
    name: "Review-heavy (built-in)",
    description: "Adds an extra security pass before merge, on top of the standard review.",
    nodes: [
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "review", kind: "prompt", config: { seam: "review" } },
      {
        id: "security",
        kind: "gate",
        config: {
          name: "Security review",
          gateMode: "gate",
          prompt: "Review the diff for security issues: injection, auth/authorization gaps, secret handling, unsafe deserialization. Block on any exploitable finding.",
        },
      },
      { id: "merge", kind: "prompt", config: { seam: "merge" } },
    ],
  }),
  linear({
    id: "builtin:compound-engineering",
    name: "Compound engineering (built-in)",
    description: "Plan → implement → review → document, invoking the compound-engineering skills at each stage.",
    nodes: [
      {
        id: "plan",
        kind: "prompt",
        config: {
          name: "Plan",
          executor: "skill",
          skillName: "compound-engineering:ce-plan",
          prompt: "Produce a short implementation plan for this task before any code is written.",
        },
      },
      { id: "execute", kind: "prompt", config: { seam: "execute" } },
      { id: "review", kind: "prompt", config: { seam: "review" } },
      {
        id: "code-review",
        kind: "gate",
        config: {
          name: "Code review",
          executor: "skill",
          skillName: "compound-engineering:ce-code-review",
          gateMode: "gate",
          prompt: "Run a structured code review of the changes. Block merge on P0/P1 findings.",
        },
      },
      { id: "merge", kind: "prompt", config: { seam: "merge" } },
      {
        id: "document",
        kind: "prompt",
        config: {
          name: "Document learnings",
          executor: "skill",
          skillName: "compound-engineering:ce-compound",
          prompt: "Capture any reusable learnings from this task into docs/solutions.",
        },
      },
    ],
  }),
  // The stepwise coding workflow (KTD-9) — step inversion as authored graph
  // structure (parse-steps → foreach{ step-execute → step-review } → review →
  // merge). Authored directly as a v2 IR (the `linear` helper only builds simple
  // pipelines); it is read-only like every built-in. Requires the
  // `workflowGraphExecutor` flag at run time (foreach/step-review/parse-steps are
  // interpreter-only node kinds, KTD-8); under the flag-off compile path its
  // step-inversion nodes are skipped, the same posture as the other seam nodes.
  {
    id: "builtin:stepwise-coding",
    name: "Stepwise coding (built-in)",
    description:
      "Per-step plan, execute, and review modeled as graph structure: each planned step runs and is reviewed (approve / revise / rethink) before the next, with bounded rework. Requires the workflow graph executor.",
    kind: "workflow",
    ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
    layout: {
      start: { x: 60, y: 160 },
      plan: { x: 230, y: 160 },
      parse: { x: 400, y: 160 },
      steps: { x: 570, y: 160 },
      "rework-hold": { x: 570, y: 320 },
      review: { x: 740, y: 160 },
      merge: { x: 910, y: 160 },
      end: { x: 1080, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_WORKFLOWS.map((wf) => [wf.id, wf]));

export function getBuiltinWorkflow(id: string): WorkflowDefinition | undefined {
  return BUILTIN_BY_ID.get(id);
}
