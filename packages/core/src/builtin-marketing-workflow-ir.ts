import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import { completionSummaryNode } from "./builtin-completion-summary-node.js";
import { postMergeVerificationOptionalGroupNode } from "./builtin-post-merge-group.js";

/**
 * FNXC:WorkflowMarketing 2026-06-20-00:00:
 * Fusion needs a non-coding built-in workflow for marketing and content work. Keep the engine pipeline unchanged by reusing the standard lifecycle trait vocabulary and the canonical merge-primitive region while exposing marketing-specific columns and prompts for brief, draft, and editorial review phases.
 *
 * FNXC:WorkflowMarketing 2026-06-21-12:00:
 * FN-6906 expands non-coding workflow prompts so marketing agents produce structured, high-quality artifacts instead of thin role-only responses. Deliverable-producing nodes must persist the reviewable content with fn_task_document_write as the guaranteed path and may register a previewable artifact with fn_artifact_register when that tool is available.
 */
const RAW_BUILTIN_MARKETING_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-marketing-workflow",
  columns: [
    { id: "ideation", name: "Ideation", traits: [{ trait: "intake" }] },
    {
      id: "backlog",
      name: "Backlog",
      traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
    },
    {
      id: "drafting",
      name: "Drafting",
      traits: [
        { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
        { trait: "abort-on-exit" },
        { trait: "timing" },
      ],
    },
    {
      id: "editorial-review",
      name: "Editorial review",
      traits: [{ trait: "merge-blocker" }, { trait: "human-review" }, { trait: "stall-detection" }, { trait: "merge" }],
    },
    { id: "published", name: "Published", traits: [{ trait: "complete" }] },
    { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
  ],
  nodes: [
    { id: "start", kind: "start", column: "ideation" },
    {
      id: "brief",
      kind: "prompt",
      column: "ideation",
      config: {
        seam: "planning",
        name: "Content brief",
        prompt:
          "You are a marketing content strategist. Use the task description, any attached context, and prior stakeholder notes to turn the request into a concrete content brief. Structure the output with: 1) audience and customer problem, 2) channel, format, and distribution context, 3) key message and supporting proof points, 4) required source material or claims to verify, 5) success metric, CTA, and approval constraints, and 6) open questions or assumptions. A good brief is specific enough for a marketing copywriter to execute without guessing, avoids unsupported claims, calls out missing inputs, and keeps the scope aligned to the task rather than inventing a campaign.",
      },
    },
    {
      id: "draft",
      kind: "prompt",
      column: "drafting",
      config: {
        seam: "execute",
        name: "Draft content",
        prompt:
          "You are a marketing copywriter executing the approved brief. Use the task description, the content brief, prior-node output, source material, and any brand or channel constraints to produce the requested deliverable. Structure the response with: 1) a short execution summary, 2) the finished content in the required format, 3) channel-specific variants or subject lines when useful, 4) source/claim notes and assumptions, and 5) a publication-readiness checklist tied to audience intent, brand voice, CTA clarity, format requirements, and the brief's success metric. The copy should be clear, audience-specific, factual, and ready for editorial review; avoid generic filler, unverified claims, and off-brief tangents. Persist the finished content as a task document using fn_task_document_write with key \"marketing-draft\" so the human can review it. If an artifact-registry tool (fn_artifact_register) is available, also register the deliverable as a previewable artifact.",
        maxRetries: 2,
      },
    },
    {
      id: "editorial",
      kind: "prompt",
      column: "editorial-review",
      config: {
        seam: "review",
        name: "Editorial review",
        prompt:
          "You are an independent editorial reviewer. Use the task description, the content brief, the marketing draft, and any persisted marketing-draft task document to assess publication readiness. Structure the review with: 1) verdict and publication recommendation, 2) brief-compliance findings, 3) brand voice, audience fit, channel fit, and CTA clarity notes, 4) factual accuracy and unsupported-claim checks, 5) required edits that block publication, and 6) non-blocking polish suggestions. Good editorial review is specific, evidence-backed, and focused on substantive quality issues; block only issues that would harm publication readiness, compliance with the brief, or customer trust, and avoid subjective nits without a clear publication impact.",
      },
    },
    completionSummaryNode("editorial-review"),
    { id: "merge-gate", kind: "merge-gate", column: "editorial-review", config: { gate: "auto-merge" } },
    { id: "merge-retry", kind: "retry-backoff", column: "editorial-review", config: { policy: "merge", maxAttempts: 3 } },
    { id: "merge-manual-hold", kind: "manual-merge-hold", column: "editorial-review", config: { release: "manual" } },
    {
      id: "branch-group-member-integration",
      kind: "branch-group-member-integration",
      column: "editorial-review",
      config: { reworkRegion: true, maxReworkCycles: 3 },
    },
    { id: "branch-group-promotion", kind: "branch-group-promotion", column: "editorial-review" },
    {
      id: "merge-attempt",
      kind: "merge-attempt",
      column: "editorial-review",
      config: { capability: "task-merge", reworkRegion: true, maxReworkCycles: 3 },
    },
    { id: "recovery-router", kind: "recovery-router", column: "editorial-review", config: { surfaces: ["merge", "retry"] } },
    postMergeVerificationOptionalGroupNode("published"),
    { id: "end", kind: "end", column: "published" },
  ],
  edges: [
    { from: "start", to: "brief" },
    { from: "brief", to: "draft", condition: "success" },
    { from: "draft", to: "editorial", condition: "success" },
    { from: "editorial", to: "completion-summary", condition: "success" },
    { from: "completion-summary", to: "merge-gate", condition: "success" },
    { from: "merge-gate", to: "branch-group-member-integration", condition: "outcome:auto-on" },
    { from: "merge-gate", to: "merge-manual-hold", condition: "outcome:auto-off" },
    { from: "merge-retry", to: "merge-attempt", condition: "success", kind: "rework" },
    { from: "merge-manual-hold", to: "branch-group-member-integration", condition: "success", kind: "rework" },
    { from: "branch-group-member-integration", to: "branch-group-promotion", condition: "success" },
    { from: "branch-group-member-integration", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "branch-group-promotion", to: "merge-attempt", condition: "success" },
    { from: "branch-group-promotion", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "merge-attempt", to: "post-merge-verification", condition: "success" },
    { from: "post-merge-verification", to: "end", condition: "success" },
    { from: "merge-attempt", to: "merge-retry", condition: "outcome:transient-failure" },
    { from: "merge-attempt", to: "merge-manual-hold", condition: "outcome:manual-required" },
    { from: "recovery-router", to: "merge-attempt", condition: "outcome:wake-merge", kind: "rework" },
    { from: "brief", to: "end", condition: "failure" },
    { from: "draft", to: "end", condition: "failure" },
    { from: "editorial", to: "end", condition: "failure" },
    { from: "merge-attempt", to: "end", condition: "failure" },
  ],
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

export const BUILTIN_MARKETING_WORKFLOW_IR = parseWorkflowIr(RAW_BUILTIN_MARKETING_WORKFLOW_IR);
