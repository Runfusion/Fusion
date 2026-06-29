import { BUILTIN_CODING_WORKFLOW_IR } from "./builtin-coding-workflow-ir.js";
import { BUILTIN_LEAD_GENERATION_WORKFLOW_IR } from "./builtin-lead-generation-workflow-ir.js";
import { BUILTIN_MARKETING_WORKFLOW_IR } from "./builtin-marketing-workflow-ir.js";
import { BUILTIN_PR_WORKFLOW_IR } from "./builtin-pr-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "./builtin-stepwise-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "./builtin-stepwise-final-review-coding-workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import { builtinPromptConfig } from "./builtin-workflow-prompts.js";
import { browserVerificationOptionalGroupNode } from "./builtin-browser-verification-group.js";
import { codeReviewOptionalGroupNode } from "./builtin-code-review-group.js";
import { completionSummaryNode } from "./builtin-completion-summary-node.js";
import { postMergeVerificationOptionalGroupNode } from "./builtin-post-merge-group.js";
import { planReviewOptionalGroupNode } from "./builtin-plan-review-group.js";
import {
  browserVerificationRemediationNode,
  codeReviewRemediationNode,
  planReplanNode,
} from "./builtin-workflow-remediation-nodes.js";
import type { WorkflowDefinition } from "./workflow-definition-types.js";
import type { WorkflowIr, WorkflowIrColumn, WorkflowIrNode } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";

/** Prefix marking a workflow as a read-only built-in template. */
export const BUILTIN_WORKFLOW_ID_PREFIX = "builtin:";

export function isBuiltinWorkflowId(id: string): boolean {
  return id.startsWith(BUILTIN_WORKFLOW_ID_PREFIX);
}

const PLUGIN_GATED_BUILTIN_WORKFLOWS: ReadonlyMap<string, string> = new Map([
  ["builtin:compound-engineering", "fusion-plugin-compound-engineering"],
]);

export function isBuiltinWorkflowPluginGated(id: string): boolean {
  return PLUGIN_GATED_BUILTIN_WORKFLOWS.has(id);
}

export function getRequiredPluginIdForBuiltinWorkflow(id: string): string | undefined {
  return PLUGIN_GATED_BUILTIN_WORKFLOWS.get(id);
}

export function defaultEnabledBuiltinWorkflowIds(): string[] {
  return BUILTIN_WORKFLOWS.filter(
    (workflow) => workflow.kind !== "fragment" && !PLUGIN_GATED_BUILTIN_WORKFLOWS.has(workflow.id),
  ).map((workflow) => workflow.id);
}

function ceCodeReviewOptionalGroupNode(column: string): WorkflowIrNode {
  return {
    id: "code-review",
    kind: "optional-group",
    column,
    config: {
      /*
       * FNXC:Workflows 2026-06-29-10:24:
       * Compound Engineering uses the same optional Code Review toggle as other engineering built-ins, but the inner reviewer remains the CE skill. Keep the stable `code-review` group id so per-task toggles work uniformly while preserving the CE review implementation.
       */
      name: "Code Review",
      defaultOn: true,
      reworkRegion: true,
      maxReworkCycles: 3,
      /*
       * FNXC:WorkflowRemediationBudget 2026-06-29-13:56:
       * The CE Code Review group is custom because it invokes the CE skill, but its workflow-owned remediation budget must match the other built-in optional gates by defaulting to three attempts while remaining editable in workflow config.
       */
      maxRevisions: 3,
      template: {
        nodes: [
          {
            id: "code-review-step",
            kind: "gate",
            config: {
              name: "Code Review",
              executor: "skill",
              skillName: "compound-engineering:ce-code-review",
              gateMode: "gate",
              toolMode: "coding",
              prompt: "Run /ce-code-review to perform a structured code review of the changes. Block merge on P0/P1 findings.",
            },
          },
        ],
        edges: [],
      },
    },
  };
}

export function isBuiltinWorkflowEnabled(id: string, enabledIds?: readonly string[]): boolean {
  if (!isBuiltinWorkflowId(id)) return true;
  if (!enabledIds) return true;
  return enabledIds.includes(id);
}

// Stable timestamp so built-ins round-trip deterministically.
const BUILTIN_TS = "2026-01-01T00:00:00.000Z";

interface BuiltinSpec {
  id: string;
  name: string;
  description: string;
  /** Ordered node specs between start and end; seams use {seam}. */
  nodes: Array<{ id: string; kind: WorkflowIr["nodes"][number]["kind"]; config?: Record<string, unknown> }>;
  engineeringOptionalGroups?: {
    planReviewDefaultOn?: boolean;
    codeReviewDefaultOn?: boolean;
    browserVerificationDefaultOn?: boolean;
  };
}

function defaultColumnForLinearNode(node: WorkflowIrNode): string {
  const seam = node.config?.seam;
  if (seam === "execute") return "in-progress";
  if (seam === "review") return "in-review";
  if (seam === "merge") return "in-review";
  return "todo";
}

function canonicalBuiltinWorkflowColumns(): WorkflowIrColumn[] {
  if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") {
    throw new Error("builtin coding workflow must be v2 to provide canonical columns");
  }
  return BUILTIN_CODING_WORKFLOW_IR.columns.map((column) => ({
    ...column,
    traits: column.traits.map((trait) => ({
      ...trait,
      config: trait.config ? { ...trait.config } : undefined,
    })),
  }));
}

/** Build a linear IR (start → nodes… → end) with simple x-spaced layout. */
function linear(spec: BuiltinSpec): WorkflowDefinition {
  const specNodes = spec.engineeringOptionalGroups
    ? withEngineeringOptionalGroups(spec.nodes, spec.engineeringOptionalGroups)
    : spec.nodes;
  const workflowNodes = withPostMergeVerificationNode(withCompletionSummaryNode(specNodes));
  const hasPlanReview = workflowNodes.some((node) => node.id === "plan-review");
  const hasBrowserVerification = workflowNodes.some((node) => node.id === "browser-verification");
  const hasCodeReview = workflowNodes.some((node) => node.id === "code-review");
  const remediationNodes = hasPlanReview || hasBrowserVerification || hasCodeReview
    ? [
        ...(hasPlanReview ? [planReplanNode("triage")] : []),
        ...(hasBrowserVerification ? [browserVerificationRemediationNode("in-progress")] : []),
        ...(hasCodeReview ? [codeReviewRemediationNode("in-progress")] : []),
      ]
    : [];
  const nodes: WorkflowIr["nodes"] = [
    { id: "start", kind: "start" },
    ...workflowNodes,
    ...remediationNodes,
    { id: "end", kind: "end" },
  ];
  const edges: WorkflowIr["edges"] = [];
  const successPathNodes: WorkflowIr["nodes"] = [{ id: "start", kind: "start" }, ...workflowNodes, { id: "end", kind: "end" }];
  for (let i = 0; i < successPathNodes.length - 1; i += 1) {
    edges.push({ from: successPathNodes[i].id, to: successPathNodes[i + 1].id, condition: "success" });
  }
  // Seam nodes also fail straight to end (mirrors the legacy pipeline).
  for (const node of workflowNodes) {
    if ((typeof node.config?.seam === "string" || node.kind === "optional-group") && node.config?.summaryTarget !== "task") {
      const failureTarget =
        node.id === "plan-review"
          ? "plan-replan"
          : node.id === "browser-verification"
          ? "browser-verification-remediation"
          : node.id === "code-review"
          ? "code-review-remediation"
          : "end";
      edges.push({ from: node.id, to: failureTarget, condition: "failure" });
    }
  }
  /*
   * FNXC:WorkflowRemediation 2026-06-29-12:12:
   * Review failures are workflow policy, not terminal executor failures. Linear built-ins that opt into Plan Review, Browser Verification, or Code Review must route remediation success back to the owning gate so retry/restart keeps executing the graph instead of parking at an orphan remediation node or falling through to done.
   */
  if (hasPlanReview) {
    edges.push({ from: "plan-replan", to: "plan-review", condition: "success", kind: "rework" });
  }
  if (hasBrowserVerification) {
    edges.push({
      from: "browser-verification-remediation",
      to: "browser-verification",
      condition: "success",
      kind: "rework",
    });
  }
  if (hasCodeReview) {
    edges.push({ from: "code-review-remediation", to: "code-review", condition: "success", kind: "rework" });
  }
  const layout: Record<string, { x: number; y: number }> = {};
  nodes.forEach((node, i) => {
    layout[node.id] = { x: 60 + i * 170, y: 160 };
  });
  /*
   * FNXC:Workflows 2026-06-28-00:00:
   * Linear built-ins must mirror BUILTIN_CODING_WORKFLOW_IR column traits because the post-cutover hold/release sweep is the only todo→in-progress dispatcher. Both formerly-v1 linear graphs (quick-fix, review-heavy, design) and v2-only compound-engineering need todo hold(capacity), in-progress wip, and in-review merge traits or their cards strand in Todo.
   */
  const ir = parseWorkflowIr({
    version: "v2",
    name: spec.name,
    columns: canonicalBuiltinWorkflowColumns(),
    nodes: nodes.map((node) => (node.column ? node : { ...node, column: defaultColumnForLinearNode(node) })),
    edges,
  });
  if (ir.version !== "v2" || !ir.columns.find((column) => column.id === "todo")?.traits.some((trait) => trait.trait === "hold")) {
    throw new Error(`linear built-in workflow '${spec.id}' must synthesize a hold-capacity todo column`);
  }
  // Attach the moved-key settings catalog (U1/U3, R4) so every built-in workflow
  // carries its declarations through the resolver path (resolveWorkflowIrById →
  // resolveEffectiveSettings). Defaults are byte-equal to legacy
  // DEFAULT_PROJECT_SETTINGS literals, so this is behavior-inert.
  if (ir.version === "v2") {
    ir.settings = BUILTIN_WORKFLOW_SETTINGS;
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    // Linear built-ins remain selectable workflows; catalog entries authored
    // directly below may opt into fragment kind when they are palette templates.
    kind: "workflow",
    ir,
    layout,
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  };
}

function withEngineeringOptionalGroups(
  nodes: BuiltinSpec["nodes"],
  options: NonNullable<BuiltinSpec["engineeringOptionalGroups"]>,
): BuiltinSpec["nodes"] {
  const executeIndex = nodes.findIndex((node) => node.id === "execute");
  if (executeIndex < 0) return nodes;
  /*
   * FNXC:WorkflowBuiltins 2026-06-29-10:17:
   * Engineering built-ins must expose the same operator toggles: Plan Review before execution, then Browser Verification and Code Review after implementation. Quick Fix keeps all three default-off; other engineering built-ins keep plan/code review default-on and browser verification default-off.
   */
  return [
    ...nodes.slice(0, executeIndex),
    planReviewOptionalGroupNode("in-progress", { defaultOn: options.planReviewDefaultOn ?? true }),
    nodes[executeIndex],
    browserVerificationOptionalGroupNode("in-progress", { defaultOn: options.browserVerificationDefaultOn ?? false }),
    codeReviewOptionalGroupNode("in-progress", { defaultOn: options.codeReviewDefaultOn ?? true }),
    ...nodes.slice(executeIndex + 1),
  ];
}

function withCompletionSummaryNode(nodes: BuiltinSpec["nodes"]): BuiltinSpec["nodes"] {
  if (nodes.some((node) => node.id === "completion-summary")) return nodes;
  const mergeIndex = nodes.findIndex((node) => node.config?.seam === "merge" || node.id === "merge");
  const insertIndex = mergeIndex >= 0 ? mergeIndex : nodes.length;
  return [
    ...nodes.slice(0, insertIndex),
    completionSummaryNode("in-review"),
    ...nodes.slice(insertIndex),
  ];
}

function withPostMergeVerificationNode(nodes: BuiltinSpec["nodes"]): BuiltinSpec["nodes"] {
  if (nodes.some((node) => node.id === "post-merge-verification")) return nodes;
  const mergeIndex = nodes.findIndex((node) => node.config?.seam === "merge" || node.id === "merge");
  if (mergeIndex < 0) return nodes;
  return [
    ...nodes.slice(0, mergeIndex + 1),
    postMergeVerificationOptionalGroupNode("done"),
    ...nodes.slice(mergeIndex + 1),
  ];
}

/**
 * Read-only built-in workflow templates. Selectable like any workflow; they
 * cannot be edited or deleted. In compile mode (flag off) only the custom
 * prompt/script/gate nodes become WorkflowSteps; the execute/review/merge
 * seams are honored only by the graph interpreter (flag on).
 */
export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "builtin:coding",
    name: "Coding (built-in)",
    description: "Default coding pipeline: plan steps, execute them one at a time, then run the optional final code review and merge.",
    kind: "workflow",
    ir: BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
    layout: {
      start: { x: 60, y: 160 },
      plan: { x: 230, y: 160 },
      "plan-review": { x: 400, y: 160 },
      "plan-replan": { x: 400, y: 320 },
      parse: { x: 570, y: 160 },
      steps: { x: 740, y: 160 },
      "browser-verification": { x: 910, y: 160 },
      "browser-verification-remediation": { x: 910, y: 320 },
      "code-review": { x: 1080, y: 160 },
      "code-review-remediation": { x: 1080, y: 320 },
      "completion-summary": { x: 1250, y: 160 },
      "merge-gate": { x: 1420, y: 160 },
      "branch-group-member-integration": { x: 1590, y: 80 },
      "branch-group-promotion": { x: 1760, y: 80 },
      "merge-attempt": { x: 1930, y: 160 },
      "merge-retry": { x: 2100, y: 80 },
      "recovery-router": { x: 2100, y: 240 },
      "merge-manual-hold": { x: 1590, y: 240 },
      "post-merge-verification": { x: 2270, y: 160 },
      end: { x: 2440, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
  {
    id: "builtin:legacy-coding",
    name: "Legacy coding (built-in)",
    description: "The original monolithic coding pipeline: implement, review, then merge without graph-owned per-step execution.",
    kind: "workflow",
    ir: BUILTIN_CODING_WORKFLOW_IR,
    /*
     * FNXC:WorkflowBuiltins 2026-06-29-08:33:
     * Legacy coding now exposes the same optional Plan Review, Browser Verification, and Code Review nodes as the IR. Keep layout keys in graph order so task details and workflow definition cards do not render review steps out of sequence or at fallback coordinates.
     */
    layout: {
      start: { x: 60, y: 160 },
      planning: { x: 230, y: 160 },
      "plan-review": { x: 400, y: 160 },
      "plan-replan": { x: 400, y: 320 },
      execute: { x: 570, y: 160 },
      "browser-verification": { x: 740, y: 160 },
      "browser-verification-remediation": { x: 740, y: 320 },
      "code-review": { x: 910, y: 160 },
      "code-review-remediation": { x: 910, y: 320 },
      "completion-summary": { x: 1080, y: 160 },
      review: { x: 1250, y: 160 },
      "merge-gate": { x: 1420, y: 160 },
      "branch-group-member-integration": { x: 1590, y: 80 },
      "branch-group-promotion": { x: 1760, y: 80 },
      "merge-attempt": { x: 1930, y: 160 },
      "merge-retry": { x: 2100, y: 80 },
      "recovery-router": { x: 2100, y: 240 },
      "merge-manual-hold": { x: 1590, y: 240 },
      "post-merge-verification": { x: 2270, y: 160 },
      end: { x: 2440, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
  linear({
    id: "builtin:quick-fix",
    name: "Quick fix (built-in)",
    description: "Implement and merge with no review step — for trivial, low-risk changes.",
    engineeringOptionalGroups: {
      planReviewDefaultOn: false,
      codeReviewDefaultOn: false,
      browserVerificationDefaultOn: false,
    },
    nodes: [
      { id: "execute", kind: "prompt", config: builtinPromptConfig("execute", "Execute") },
      { id: "merge", kind: "prompt", config: builtinPromptConfig("merge", "Merge boundary") },
    ],
  }),
  linear({
    id: "builtin:review-heavy",
    name: "Review-heavy (built-in)",
    description: "Adds an extra security pass before merge, on top of the standard review.",
    engineeringOptionalGroups: {},
    nodes: [
      { id: "execute", kind: "prompt", config: builtinPromptConfig("execute", "Execute") },
      { id: "review", kind: "prompt", config: builtinPromptConfig("review", "Review") },
      {
        id: "security",
        kind: "gate",
        config: {
          name: "Security review",
          gateMode: "gate",
          prompt: "Review the diff for security issues: injection, auth/authorization gaps, secret handling, unsafe deserialization. Block on any exploitable finding.",
        },
      },
      { id: "merge", kind: "prompt", config: builtinPromptConfig("merge", "Merge boundary") },
    ],
  }),
  {
    id: "builtin:marketing",
    name: "Marketing (built-in)",
    description: "Marketing content pipeline: ideate, brief, draft, editorial review, then publish via the standard lifecycle merge primitives.",
    kind: "workflow",
    ir: BUILTIN_MARKETING_WORKFLOW_IR,
    layout: {
      start: { x: 60, y: 160 },
      brief: { x: 230, y: 160 },
      draft: { x: 400, y: 160 },
      editorial: { x: 570, y: 160 },
      "completion-summary": { x: 740, y: 160 },
      "merge-gate": { x: 910, y: 160 },
      "branch-group-member-integration": { x: 1080, y: 80 },
      "branch-group-promotion": { x: 1250, y: 80 },
      "merge-attempt": { x: 1420, y: 160 },
      "merge-retry": { x: 1590, y: 80 },
      "recovery-router": { x: 1590, y: 240 },
      "merge-manual-hold": { x: 1080, y: 240 },
      "post-merge-verification": { x: 1760, y: 160 },
      end: { x: 1930, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
  /*
   * FNXC:Workflows 2026-06-21-00:00:
   * FN-6904 requires every compound-engineering stage prompt to name its /ce- slash command explicitly. The prompt body stays self-documenting and reinforces the skill invocation even when executor skill preambles change.
   */
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
          // Coding mode so ce-plan can fan out to its research subagents via
          // fn_spawn_agent (registered only for coding-mode steps). It is not
          // meant to write — see the accepted write-capability posture (Risk-1).
          toolMode: "coding",
          prompt: "Run /ce-plan to produce the CE plan document artifact for this task under docs/plans/ before any code is written.",
        },
      },
      {
        /*
         * FNXC:Workflows 2026-06-27-00:00:
         * FN-7144 requires compound-engineering to expose the markdown-only ce-doc-review pass as an optional non-blocking stage after planning. This preserves the WHAT/HOW boundary: ce-plan writes the HOW plan doc, ce-doc-review checks coherence and scope alignment, and merge-blocking code review remains the later ce-code-review gate.
         */
        id: "ce-doc-review",
        kind: "optional-group",
        config: {
          name: "CE Doc Review",
          defaultOn: false,
          template: {
            nodes: [
              {
                id: "ce-doc-review-step",
                kind: "prompt",
                config: {
                  name: "CE Doc Review",
                  executor: "skill",
                  skillName: "compound-engineering:ce-doc-review",
                  toolMode: "coding",
                  gateMode: "advisory",
                  prompt: "Run /ce-doc-review in headless advisory mode against the markdown CE plan document produced by /ce-plan (normally the latest docs/plans artifact). Apply only safe markdown fixes; if no markdown CE plan is available, report the skip as notes without blocking execution.",
                },
              },
            ],
            edges: [],
          },
        },
      },
      planReviewOptionalGroupNode("in-progress"),
      {
        id: "execute",
        kind: "prompt",
        config: {
          name: "Execute",
          executor: "skill",
          skillName: "compound-engineering:ce-work",
          // Coding mode so the step has write + spawn tools (readonly is the
          // default and would strip them). ce-work does the implementation the
          // CE way instead of the generic executor seam.
          toolMode: "coding",
          prompt: "Run /ce-work to execute the plan for this task, following existing patterns and maintaining quality throughout.",
        },
      },
      browserVerificationOptionalGroupNode("in-progress"),
      ceCodeReviewOptionalGroupNode("in-progress"),
      {
        id: "commit-pr",
        kind: "prompt",
        config: {
          name: "Commit & open PR",
          executor: "skill",
          skillName: "compound-engineering:ce-commit-push-pr",
          // Coding mode: this step runs git + gh. Per KTD-6 it OWNS commit /
          // push / PR creation; it does NOT perform the board-state merge — that
          // stays with Fusion's merge seam below (workflow-owned merge), so the
          // two never race the same branch state.
          /*
           * FNXC:Workflows 2026-06-27-00:00:
           * FN-7144 confirms the autoMerge-off CE route: ce-commit-push-pr and ce-resolve-pr-feedback prepare the human PR flow, while the later Fusion merge seam no-ops into manual review instead of forcing an unattended board merge.
           */
          toolMode: "coding",
          prompt: "Run /ce-commit-push-pr to commit the work in logical commits, push the branch, and open a pull request with a value-first description. When project autoMerge is off, this PR is the human merge/review path; do not perform the Fusion board-state merge here.",
        },
      },
      {
        id: "resolve-feedback",
        kind: "prompt",
        config: {
          name: "Resolve PR feedback",
          executor: "skill",
          skillName: "compound-engineering:ce-resolve-pr-feedback",
          toolMode: "coding",
          // Resolves open PR review threads. On the first autonomous pass there
          // may be no feedback yet (review is async); the skill no-ops when there
          // are no threads, and a re-run picks up later feedback.
          prompt: "Run /ce-resolve-pr-feedback to resolve open PR review feedback: evaluate each thread, fix valid issues, and reply.",
        },
      },
      { id: "merge", kind: "prompt", config: builtinPromptConfig("merge", "Merge boundary") },
      {
        id: "document",
        kind: "prompt",
        config: {
          name: "Document learnings",
          executor: "skill",
          skillName: "compound-engineering:ce-compound",
          // Coding mode so ce-compound can WRITE the learning doc into
          // docs/solutions (readonly would strip write tools).
          toolMode: "coding",
          prompt: "Run /ce-compound to capture any reusable learnings from this task into docs/solutions.",
        },
      },
    ],
  }),
  // The stepwise coding workflow (KTD-9) — step inversion as authored graph
  // structure (plan-review → parse-steps → foreach{ step-execute → step-review }
  // → optional gates → review → merge). Authored directly as a v2 IR (the `linear` helper only builds simple
  // pipelines); it is read-only like every built-in and runs on the default
  // workflow graph runtime.
  {
    id: "builtin:stepwise-coding",
    name: "Coding (per-step review) (built-in)",
    description:
      "Per-step review coding pipeline: each planned step runs and is reviewed (approve / revise / rethink) before the next, with bounded rework before final review and merge.",
    kind: "workflow",
    ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
    layout: {
      start: { x: 60, y: 160 },
      plan: { x: 230, y: 160 },
      "plan-review": { x: 400, y: 160 },
      "plan-replan": { x: 400, y: 320 },
      parse: { x: 570, y: 160 },
      steps: { x: 740, y: 160 },
      "rework-hold": { x: 740, y: 320 },
      "browser-verification": { x: 910, y: 160 },
      "browser-verification-remediation": { x: 910, y: 320 },
      "code-review": { x: 1080, y: 160 },
      "code-review-remediation": { x: 1080, y: 320 },
      "completion-summary": { x: 1250, y: 160 },
      review: { x: 1420, y: 160 },
      "merge-gate": { x: 1590, y: 160 },
      "branch-group-member-integration": { x: 1760, y: 80 },
      "branch-group-promotion": { x: 1930, y: 80 },
      "merge-attempt": { x: 2100, y: 160 },
      "merge-retry": { x: 2270, y: 80 },
      "recovery-router": { x: 2270, y: 240 },
      "merge-manual-hold": { x: 1760, y: 240 },
      "post-merge-verification": { x: 2440, y: 160 },
      end: { x: 2610, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
  /**
   * FNXC:Workflows 2026-06-20-00:00:
   * Fusion needs a built-in design lane for UI-heavy work. Gate changes on the frontend-ux-design review criteria before the standard review and merge so visual hierarchy, spacing, typography, token consistency, component reuse, responsive behavior, and fit with the design language are checked without custom workflow assembly.
   *
   * FNXC:Workflows 2026-06-21-12:00:
   * FN-6906 requires non-coding design execution to produce a user-facing preview artifact, not just code changes. The execute prompt must keep the execute seam while requiring fn_task_document_write key design-preview as the guaranteed review path and optional fn_artifact_register registration when the previewable-artifact tool exists.
   */
  linear({
    id: "builtin:design",
    name: "Design (built-in)",
    description: "Implement, then run a design/UX review gate before the standard review and merge — for UI-heavy work.",
    engineeringOptionalGroups: {},
    nodes: [
      {
        id: "execute",
        kind: "prompt",
        config: {
          seam: "execute",
          name: "Execute",
          prompt:
            "You are a product-minded UI implementer for design-heavy work. Use the task description, existing UI patterns, relevant design tokens, component library conventions, and any prior planning output to implement the requested frontend/UI change while preserving the product design language. Structure your work output with: 1) implementation summary, 2) files or components changed, 3) design decisions and token/component reuse, 4) accessibility and responsive behavior considerations, and 5) verification notes. After implementation, produce a visual preview for the user: capture before/after states when possible via screenshots, a rendered HTML/markdown preview, or a Storybook story/reference that shows the changed state across relevant viewports. Persist the preview reference and notes as a task document using fn_task_document_write with key \"design-preview\" so the human can preview the UI change before review or merge. If an artifact-registry tool (fn_artifact_register) is available, also register the preview or deliverable as a previewable artifact. Good design execution is consistent, accessible, responsive, token-driven, and easy for the reviewer to inspect; avoid hardcoded visual one-offs, unreviewable screenshots with no context, and changes that cannot be previewed.",
        },
      },
      {
        id: "design-review",
        kind: "gate",
        config: {
          name: "Design review",
          gateMode: "gate",
          prompt:
            "You are a UX design reviewer. Use the task description, implementation diff, existing UI patterns, design tokens, and the design-preview task document produced by the execute node to review frontend/UI changes for visual polish and consistency. Structure the review with: 1) verdict and whether the preview is sufficient for human inspection, 2) visual hierarchy and information-flow findings, 3) spacing, typography, margins, padding, gaps, and type-scale findings, 4) color and token consistency, including CSS custom properties/design tokens and no hardcoded colors, 5) component reuse versus one-off styling or duplication, 6) responsive behavior across relevant viewports, and 7) fit with the product design language, including border radius, shadows, transitions, and icon style. Good design review references the preview or explains why it is missing, focuses on user-visible regressions, and blocks merge on real visual-quality issues such as layout breaks, broken responsive behavior, hardcoded color/token violations, inconsistent component patterns, or design-language mismatches. Do not block or nit when the diff has no frontend/UI impact or no real design issue exists.",
        },
      },
      { id: "review", kind: "prompt", config: builtinPromptConfig("review", "Review") },
      { id: "merge", kind: "prompt", config: builtinPromptConfig("merge", "Merge boundary") },
    ],
  }),
  // The PR workflow (U9) — the unified PR-entity lifecycle wired end to end as
  // first-class graph nodes/edges: pr-create → await-review (hold) → pr-respond
  // (bounded rework loop) → auto-merge gate → pr-merge → end, with the await
  // states modeled as hold columns the U4 reconcile advances via external-event
  // releases. Authored directly as a v2 IR (the `linear` helper only builds
  // simple pipelines); read-only like every built-in and runs on the default
  // workflow graph runtime.
  //
  // ADDITIVE: this is a NEW built-in alongside the unchanged default
  // `builtin:coding`. Full retirement of the legacy comment/monitor PR path is
  // deferred until the graph executor is the default (see the plan's "Deferred to
  // follow-up work").
  {
    id: "builtin:pr-workflow",
    name: "PR lifecycle (built-in)",
    description:
      "The unified PR lifecycle as graph nodes: create the PR, await review, respond to changes (bounded rework loop), gate on auto-merge, then merge — with GitHub reconciliation advancing the await holds.",
    kind: "fragment",
    ir: BUILTIN_PR_WORKFLOW_IR,
    layout: {
      start: { x: 60, y: 160 },
      "pr-create": { x: 230, y: 160 },
      failed: { x: 230, y: 320 },
      "await-review": { x: 400, y: 160 },
      "pr-respond": { x: 400, y: 320 },
      "await-review-hold": { x: 570, y: 320 },
      gate: { x: 570, y: 160 },
      "manual-merge-hold": { x: 740, y: 80 },
      "await-rebase": { x: 740, y: 320 },
      "pr-merge": { x: 740, y: 160 },
      end: { x: 910, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
  {
    id: "builtin:lead-generation",
    name: "Lead generation (built-in)",
    description:
      "A business pipeline for sourcing, qualifying, enriching, and contacting leads with custom lead fields and stage columns.",
    kind: "workflow",
    ir: BUILTIN_LEAD_GENERATION_WORKFLOW_IR,
    layout: {
      start: { x: 60, y: 160 },
      "source-prospects": { x: 230, y: 160 },
      "qualify-lead": { x: 400, y: 160 },
      "qualification-gate": { x: 570, y: 160 },
      "enrich-lead": { x: 740, y: 160 },
      "draft-outreach": { x: 910, y: 160 },
      "completion-summary": { x: 1080, y: 160 },
      end: { x: 1250, y: 160 },
    },
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_WORKFLOWS.map((wf) => [wf.id, wf]));

export function getBuiltinWorkflow(id: string): WorkflowDefinition | undefined {
  return BUILTIN_BY_ID.get(id);
}
