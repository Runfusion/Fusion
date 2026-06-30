import type { WorkflowIr } from "./workflow-ir-types.js";
import { parseWorkflowIr } from "./workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import { completionSummaryNode } from "./builtin-completion-summary-node.js";

/**
 * FNXC:Workflows 2026-06-20-00:25:
 * The lead-generation built-in must be a first-class v2 workflow with its own business pipeline columns, lead-specific task fields, and inline per-stage prompts instead of coding seams.
 * The custom non-default column ids make this workflow graph-executor-oriented at runtime while still compiling its linear prompt/gate spine for legacy step materialization.
 *
 * FNXC:Workflows 2026-06-21-12:00:
 * FN-6906 expands each lead-generation stage prompt with explicit inputs, output structure, and quality bars so non-coding agents produce reviewable business artifacts. Enrichment and outreach deliverables must be persisted with fn_task_document_write as the guaranteed path and can additionally use fn_artifact_register when that previewable-artifact tool is available.
 */
const RAW_BUILTIN_LEAD_GENERATION_WORKFLOW_IR: WorkflowIr = {
  version: "v2",
  name: "builtin-lead-generation",
  columns: [
    { id: "triage", name: "Lead intake", traits: [{ trait: "intake" }] },
    { id: "sourcing", name: "Sourcing", traits: [{ trait: "timing" }] },
    {
      id: "qualification",
      name: "Qualification",
      traits: [
        { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
        { trait: "timing" },
      ],
    },
    { id: "enrichment", name: "Enrichment", traits: [{ trait: "timing" }] },
    {
      id: "outreach",
      name: "Outreach",
      traits: [
        { trait: "human-review" },
        { trait: "stall-detection", config: { timeoutMs: 86_400_000, action: "notify" } },
      ],
    },
    { id: "converted", name: "Converted", traits: [{ trait: "complete" }] },
    { id: "archived", name: "Archived", traits: [{ trait: "archived" }] },
  ],
  fields: [
    { id: "company", name: "Company", type: "string", render: { placement: "card", widget: "input" } },
    { id: "contactName", name: "Contact name", type: "string", render: { placement: "detail", widget: "input" } },
    { id: "contactEmail", name: "Contact email", type: "url", render: { placement: "detail", widget: "input" } },
    {
      id: "leadSource",
      name: "Lead source",
      type: "enum",
      options: [
        { value: "referral", label: "Referral" },
        { value: "inbound", label: "Inbound" },
        { value: "outbound", label: "Outbound" },
        { value: "event", label: "Event" },
        { value: "partner", label: "Partner" },
      ],
      render: { placement: "card", widget: "select" },
    },
    { id: "leadScore", name: "Lead score", type: "number", render: { placement: "card", widget: "input" } },
    {
      id: "leadStatus",
      name: "Lead status",
      type: "enum",
      options: [
        { value: "new", label: "New" },
        { value: "qualified", label: "Qualified" },
        { value: "contacted", label: "Contacted" },
        { value: "responded", label: "Responded" },
        { value: "won", label: "Won" },
        { value: "lost", label: "Lost" },
      ],
      render: { placement: "card", widget: "select" },
    },
  ],
  nodes: [
    { id: "start", kind: "start", column: "triage" },
    {
      id: "source-prospects",
      kind: "prompt",
      column: "sourcing",
      config: {
        name: "Source prospects",
        executor: "model",
        prompt:
          "Research and identify promising prospects for this lead-generation task. Use the task description, target market clues, existing lead fields (company, contactName, contactEmail, leadSource, leadScore, leadStatus), and any supplied ICP or territory constraints. Structure the output with: 1) sourcing assumptions and leadSource recommendation, 2) prioritized prospect/company list, 3) likely buyer persona or contact gaps, 4) trigger events or pain evidence, 5) source links or evidence notes, and 6) risks or missing data for qualification. Good sourcing is specific, traceable, and relevant to the ideal customer; avoid generic company lists, unsupported prospect claims, and invented contact details.",
      },
    },
    {
      id: "qualify-lead",
      kind: "prompt",
      column: "qualification",
      config: {
        name: "Qualify lead",
        executor: "model",
        prompt:
          "Evaluate each sourced prospect or lead against the ideal customer profile. Use the sourcing output, task description, and current lead fields (company, contactName, contactEmail, leadSource, leadScore, leadStatus) to score fit. Structure the output with: 1) company-fit rationale, 2) pain urgency and trigger strength, 3) budget, authority, and buying-signal evidence, 4) disqualifying risks, 5) recommended leadScore with scoring rationale, and 6) recommended leadStatus such as qualified or lost. Good qualification is evidence-based and conservative: continue plausible customer opportunities, but clearly mark weak-fit prospects, missing data, and assumptions rather than overstating certainty.",
      },
    },
    {
      id: "qualification-gate",
      kind: "gate",
      column: "qualification",
      config: {
        name: "Qualification go / no-go",
        gateMode: "advisory",
        prompt:
          "Advisory check: decide whether this lead or prospect should continue to enrichment. Use the qualification output, task description, and lead fields (company, contactName, contactEmail, leadSource, leadScore, leadStatus). Structure the advisory result with: 1) go/no-go recommendation, 2) evidence supporting continued enrichment, 3) concerns or missing customer data, 4) suggested leadStatus/leadScore adjustments, and 5) next-best action if the prospect is low priority. Good gate feedback is concise, fair, and useful for a human sales operator; continue plausible-fit companies while documenting risks instead of silently dropping uncertain leads.",
      },
    },
    {
      id: "enrich-lead",
      kind: "prompt",
      column: "enrichment",
      config: {
        name: "Enrich lead",
        executor: "model",
        prompt:
          "Enrich the qualified lead with company context and contact data. Use the task description, sourcing and qualification outputs, and declared lead fields (company, contactName, contactEmail, leadSource, leadScore, leadStatus) as the source of truth for what must be filled or corrected. Structure the enrichment with: 1) verified company summary, 2) relevant news, initiatives, hiring, funding, or technology signals, 3) likely stakeholders and selected contactName/contactEmail or profile URL with confidence notes, 4) personalization hooks for outreach, 5) updated lead field recommendations, and 6) source/evidence links. Good enrichment is verifiable, useful for outreach, and honest about confidence; do not invent emails or private data. Persist the enrichment deliverable as a task document using fn_task_document_write with key \"lead-enrichment\" so the human can review it. If an artifact-registry tool (fn_artifact_register) is available, also register the deliverable as a previewable artifact.",
      },
    },
    {
      id: "draft-outreach",
      kind: "prompt",
      column: "outreach",
      config: {
        name: "Draft and send outreach",
        executor: "model",
        prompt:
          "Draft concise personalized outreach for the enriched lead or prospect. Use the task description, the lead-enrichment task document when present, enrichment output, and declared lead fields (company, contactName, contactEmail, leadSource, leadScore, leadStatus). Structure the deliverable with: 1) outreach strategy and persona assumption, 2) ready-to-send initial message with subject line when appropriate, 3) personalization rationale tied to the strongest trigger or customer pain evidence, 4) low-friction call to action, 5) follow-up timing and alternate follow-up copy, and 6) any compliance or do-not-send caveats. Good outreach is brief, specific, respectful, value-led, and truthful; avoid spammy urgency, unsupported claims, and over-personalization from weak evidence. Persist the outreach draft as a task document using fn_task_document_write with key \"outreach-draft\" so the human can review it. If an artifact-registry tool (fn_artifact_register) is available, also register the deliverable as a previewable artifact.",
      },
    },
    completionSummaryNode("outreach"),
    { id: "end", kind: "end", column: "converted" },
  ],
  edges: [
    { from: "start", to: "source-prospects" },
    { from: "source-prospects", to: "qualify-lead", condition: "success" },
    { from: "qualify-lead", to: "qualification-gate", condition: "success" },
    { from: "qualification-gate", to: "enrich-lead", condition: "success" },
    { from: "enrich-lead", to: "draft-outreach", condition: "success" },
    { from: "draft-outreach", to: "completion-summary", condition: "success" },
    { from: "completion-summary", to: "end", condition: "success" },
  ],
  settings: BUILTIN_WORKFLOW_SETTINGS,
};

export const BUILTIN_LEAD_GENERATION_WORKFLOW_IR = parseWorkflowIr(
  RAW_BUILTIN_LEAD_GENERATION_WORKFLOW_IR,
);
