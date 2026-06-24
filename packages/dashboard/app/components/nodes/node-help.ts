import type { WorkflowEditorNodeKind, WorkflowFlowNodeData } from "./WorkflowNodeTypes";

/*
FNXC:WorkflowEditor 2026-06-21-10:00:
The node detail pane must teach, not just edit. Every workflow node — including the engine-managed graph-only policy nodes (merge gate, branch-group member integration / promotion, PR nodes, recovery/retry) — needs an in-editor Help section describing what it does, how to configure it, and its inputs/outputs/edges. This was prompted by a user unable to tell what "branch-group-member-integration", "branch-group-promotion", and "merge gate" meant in the editor.

Help is keyed by the node's EFFECTIVE kind: the preserved original IR kind (`data.irKind`) when present, else the editor kind (`data.kind`). Graph-only IR kinds collapse to merge/gate/hold editor shapes via GRAPH_ONLY_EDITOR_KIND, so without the preserved kind the branch-group/PR/merge nodes would all read as a generic "merge"/"gate".

Per-node body text is English reference documentation (analogous to node-summary's raw, untranslated config values); only the repeated structural section labels are routed through i18n by the inspector. Keep this content in sync when node config fields or edge routing change.
*/

/** A node's effective kind for help lookup: the preserved original IR kind when
 *  the editor collapsed a graph-only policy node onto a generic shape, else the
 *  editor kind. Mirrors workflow-flow-mapping's `preservedIrKind`. */
export function effectiveNodeKind(data: WorkflowFlowNodeData): string {
  return typeof data.irKind === "string" ? data.irKind : data.kind;
}

export interface NodeHelp {
  /** Human title for the node kind (the inspector heading reuses this). */
  title: string;
  /** One- to two-sentence description of what the node does. */
  summary: string;
  /** How to configure it. Omitted for structural nodes with no config. */
  configure?: string;
  /** What arrives at the node (incoming edges / available context). */
  inputs: string;
  /** What the node produces / passes downstream. */
  outputs: string;
  /** Outgoing edges and the conditions/outcomes that route them. */
  edges: string;
  /** Engine-managed policy node: surfaced read-only, not hand-authored. The
   *  inspector shows an "Engine-managed" badge for these. */
  graphOnly?: boolean;
}

/** Help content keyed by effective node kind. Covers every editor kind plus the
 *  graph-only IR kinds (merge lifecycle, branch groups, PR mode, recovery). */
const NODE_HELP: Record<string, NodeHelp> = {
  // ── Editor (user-authored) kinds ──────────────────────────────────────────
  start: {
    title: "Start",
    summary: "Marks where a task enters the workflow. Every workflow has exactly one start node.",
    configure:
      "Set the Entry column to choose which board column a task lands in when it enters (v2 workflows). Leave on Auto to use the first column.",
    inputs: "None — this is the entry point.",
    outputs: "Hands the task to the first downstream node.",
    edges: "One outgoing edge (success). No incoming edges.",
  },
  end: {
    title: "End",
    summary: "A terminal state. A task that reaches an end node is finished on that path.",
    inputs: "One or more incoming edges.",
    outputs: "None — the task stops here.",
    edges: "Incoming edges only; no outgoing edges.",
  },
  prompt: {
    title: "Prompt (agent step)",
    summary:
      "Runs a unit of work against the task — an AI model, a named agent, a skill, or a CLI command. The workhorse node for executing, planning, and reviewing.",
    configure:
      "Write the Prompt, then pick an Executor (model, agent, skill, CLI, or CLI-agent) and its options (model, agent, skill, or command). Optionally set Gate mode (advisory vs blocking), Max retries, Auto-approve, or Wait for user input.",
    inputs: "The task plus any prior step output and context.",
    outputs: "The step's result, passed downstream; may record a gate verdict.",
    edges: "success / failure outgoing edges. As a blocking gate it can stop the task on failure.",
  },
  script: {
    title: "Script",
    summary: "Runs a named project script (defined in project settings) as a workflow step.",
    configure:
      "Set Script name to a script from project settings. Set Gate mode to choose whether a non-zero exit blocks the task. The node prompt is passed to the script via FUSION_NODE_PROMPT.",
    inputs: "The task; the node prompt via FUSION_NODE_PROMPT.",
    outputs: "The script's exit status and output.",
    edges: "success / failure.",
  },
  gate: {
    title: "Gate",
    summary:
      "A decision checkpoint that evaluates a prompt and routes the task by its verdict, optionally blocking progress.",
    configure:
      "Write the gate Prompt. Set Gate mode to Advisory (records a verdict but never blocks) or Gate (blocks the task on failure).",
    inputs: "The task plus prior context.",
    outputs: "A pass/fail (or outcome) verdict.",
    edges: "success / failure; a blocking gate holds the task on failure.",
  },
  merge: {
    title: "Merge boundary",
    summary:
      "A marker separating pre-merge from post-merge steps. Steps before it run before the branch merges; steps after run after.",
    configure: "No fields to set — placement is what matters. Position it where the merge happens in your pipeline.",
    inputs: "The task after upstream steps complete.",
    outputs: "Passes the task to post-merge steps.",
    edges: "One outgoing edge (success).",
  },
  hold: {
    title: "Hold",
    summary:
      "Pauses the task until a release condition is met — a manual promote, a timer, downstream capacity, a dependency, or an external event.",
    configure:
      "Pick a Release condition: Manual promote, Timer, Downstream capacity, Dependency complete, or External event.",
    inputs: "The task arriving from upstream.",
    outputs: "Releases the task downstream once the condition is satisfied.",
    edges: "One outgoing edge (success), taken once released.",
  },
  split: {
    title: "Split (parallel branch)",
    summary:
      "Fans the task out into multiple branches that run concurrently. Pair with a Join downstream to recombine them.",
    configure: "No fields to set — connect multiple outgoing edges; each becomes a parallel branch.",
    inputs: "A single task path.",
    outputs: "Multiple concurrent branches.",
    edges: "Multiple outgoing edges, one per branch. Recombine with a Join.",
  },
  join: {
    title: "Join",
    summary: "Waits for parallel branches (from a Split) and recombines them according to a join policy.",
    configure:
      "Set Join mode: All branches, Any branch, or Quorum (n) with a count. Set On branch failure to Collect (wait for all) or Fail-fast (cancel siblings).",
    inputs: "Multiple parallel branches.",
    outputs: "A single resumed path once the join policy is satisfied.",
    edges: "One outgoing edge (success), taken when the join condition is met.",
  },
  foreach: {
    title: "For-each",
    summary:
      "Runs a template of steps once per item (e.g. per parsed step), sequentially or in parallel. Renders as a group you drop step nodes into.",
    configure:
      "Set Mode (sequential/parallel), Isolation (shared or per-step worktree), Concurrency (parallel only), and Max rework cycles (the bound on rework loop-backs). Drop a step-execute node inside.",
    inputs: "A collection of items (e.g. parsed steps) plus the task.",
    outputs: "Aggregated per-item results.",
    edges:
      "success once all iterations finish. Internal rework edges loop back within a step instance, bounded by Max rework cycles.",
  },
  loop: {
    title: "Loop",
    summary:
      "Repeats a template of steps until an exit condition is met or a cap is hit. Renders as a group you drop loop steps into.",
    configure:
      "Set the Exit condition (output contains / output matches regex) and its value or pattern, an optional Watch node id, Max iterations, and Timeout (ms).",
    inputs: "The task plus the loop body steps.",
    outputs: "The final iteration's result.",
    edges: "One outgoing edge (success) on exit. Exits on condition match, max iterations, or timeout.",
  },
  // FNXC:WorkflowOptionalGroup 2026-06-21-11:30: An optional-group is a container whose body runs once when the task enables it and is skipped otherwise. Enable state is the per-task `enabledWorkflowSteps` facet, seeded from the group's `defaultOn`.
  "optional-group": {
    title: "Optional group",
    summary:
      "Holds a group of steps that run only when the task has this group enabled. Enabled tasks run the group's steps once at this position; disabled tasks pass straight through. Renders as a group you drop step nodes into.",
    configure:
      "Set the group Name and whether it is Enabled by default for new tasks (defaultOn). A task can override the default per-task. Drop the optional steps inside the region.",
    inputs: "The task arriving from upstream, plus prior context.",
    outputs: "The group's result when enabled; an unchanged pass-through when disabled.",
    edges:
      "success once the group finishes (or is skipped). A template failure inside an enabled group routes the group's failure edge.",
  },
  "step-review": {
    title: "Step review",
    summary:
      "An AI review gate that emits a verdict (approve / revise / rethink / unavailable) used to route the task — typically back for rework or forward on approval.",
    configure:
      "Set Review type (plan or code) and an optional Review model. Route each outgoing edge by verdict; mark a loop-back edge as Rework.",
    inputs: "The artifact or step output to review.",
    outputs: "A verdict: approve, revise, rethink, or unavailable.",
    edges:
      "Verdict edges (outcome:approve / revise / rethink / unavailable). A rework edge loops back, bounded by Max rework cycles.",
  },
  "parse-steps": {
    title: "Parse steps",
    summary:
      "Parses a task artifact (e.g. PROMPT.md) into discrete steps a downstream for-each can iterate over.",
    configure: "Pick the Artifact to parse (e.g. PROMPT.md) and the Parser (e.g. step-headings, plus any plugin parsers).",
    inputs: "A task artifact or document.",
    outputs: "A list of parsed steps for a downstream for-each.",
    edges: "success / failure.",
  },
  code: {
    title: "Code",
    summary:
      "Runs a sandboxed TypeScript snippet as a workflow step — for lightweight transforms, routing, or computed values.",
    configure: "Write the TypeScript Source and an optional Timeout (ms). Syntax is validated at save.",
    inputs: "Task context available to the snippet.",
    outputs: "The snippet's return value.",
    edges: "success / failure.",
  },
  notify: {
    title: "Notify",
    summary:
      "Emits a notification event (and optional title/message) without changing the task's path — for pings on state changes.",
    configure:
      "Pick an Event type (or a Custom event) and optional Title/Message. Templates may use {{taskTitle}}, {{taskId}}, {{workflowName}}, and {{context:key}}.",
    inputs: "The task at this point in the flow.",
    outputs: "A notification event; the task continues unchanged.",
    edges: "One outgoing edge (success); the node is pass-through.",
  },

  // ── Graph-only (engine-managed) IR kinds ──────────────────────────────────
  "merge-gate": {
    title: "Auto-merge gate",
    summary:
      "Checks whether the task is ready to auto-merge: a live PR/merge entity exists, auto-merge is opted in, and the entity is merge-ready (approved, checks green, mergeable clean).",
    configure: "Engine-managed checkpoint — not hand-edited. Governed by the project and task auto-merge settings.",
    inputs: "An approved task with its PR/merge entity.",
    outputs: "An auto-on / auto-off decision.",
    edges:
      "outcome:auto-on → branch-group member integration; auto-off → parks at the manual merge hold for a human.",
    graphOnly: true,
  },
  "merge-attempt": {
    title: "Merge attempt",
    summary:
      "Performs the actual merge of the task's branch toward the integration/default branch (squash by project default), with conflict and post-merge audit handling.",
    configure: "Engine-managed — not hand-edited. Follows the project's merge strategy and audit settings.",
    inputs: "A promotion-ready branch.",
    outputs: "A merged branch, or a conflict requiring manual resolution.",
    edges: "success → end; conflict/failure → manual merge hold.",
    graphOnly: true,
  },
  "manual-merge-hold": {
    title: "Manual merge hold",
    summary:
      "Parks the task in review for a human to merge when auto-merge is off or a step needs manual resolution. While auto-merge is off, in-review is terminal until a person merges.",
    configure: "Engine-managed park state — not hand-edited.",
    inputs: "A task blocked from auto-merge, or one with a merge conflict.",
    outputs: "A human-resolved merge that resumes the flow.",
    edges: "On manual resolution, loops back into integration/merge (rework).",
    graphOnly: true,
  },
  "retry-backoff": {
    title: "Retry backoff",
    summary: "Waits a backoff interval before retrying a failed step, bounded by a retry budget.",
    configure: "Engine-managed — not hand-edited.",
    inputs: "A failed step eligible for retry.",
    outputs: "A delayed retry of the step.",
    edges: "Loops back to the step until the retry budget is exhausted.",
    graphOnly: true,
  },
  "recovery-router": {
    title: "Recovery router",
    summary:
      "A self-healing decision point that routes a stuck or interrupted task onto the right recovery path (retry, rebound, or escalate).",
    configure: "Engine-managed — not hand-edited.",
    inputs: "A task in an anomalous or interrupted state.",
    outputs: "A recovery-route decision.",
    edges: "Branches to retry, rebound, or manual paths by recovery outcome.",
    graphOnly: true,
  },
  "branch-group-member-integration": {
    title: "Branch group · member integration",
    summary:
      "For a task in a shared branch group, integrates this member's work onto the group's shared branch. A soft pre-integration step that runs even when global auto-merge is off (it only assembles the group branch).",
    configure: "Engine-managed — not hand-edited. Active only for shared-branch-group members.",
    inputs: "An approved group-member task and the group's shared branch.",
    outputs: "The member's work landed on the shared branch.",
    edges: "success → branch group promotion; manual-required → manual merge hold.",
    graphOnly: true,
  },
  "branch-group-promotion": {
    title: "Branch group · promotion",
    summary:
      "Once all members have landed on the shared branch, carries the complete group forward — merging the group branch toward the integration branch and creating-or-reusing the group's single managed PR. Idempotent: re-running never creates a second PR. Gated by group/global auto-merge.",
    configure: "Engine-managed — not hand-edited. Runs once the group is complete and auto-merge is eligible.",
    inputs: "A complete shared branch group (all members landed).",
    outputs: "The group promoted toward the integration branch, plus its single managed PR.",
    edges: "success → merge attempt; manual-required → manual merge hold.",
    graphOnly: true,
  },
  "pr-create": {
    title: "PR create",
    summary: "Creates (or reuses) the pull request for the task in pull-request merge mode.",
    configure: "Engine-managed — not hand-edited. Active in pull-request merge mode.",
    inputs: "A task branch ready for review.",
    outputs: "An open PR entity (created or reused).",
    edges: "success → the PR review/merge path.",
    graphOnly: true,
  },
  "pr-respond": {
    title: "PR respond",
    summary:
      "Responds to PR review feedback — addressing comments and pushing follow-up commits — during the PR review cycle.",
    configure: "Engine-managed — not hand-edited.",
    inputs: "PR review comments and threads.",
    outputs: "Replies and follow-up commits on the PR.",
    edges: "Loops within the PR review cycle until feedback is resolved.",
    graphOnly: true,
  },
  "pr-merge": {
    title: "PR merge",
    summary: "Merges the pull request once it is approved and all checks pass, in pull-request mode.",
    configure: "Engine-managed — not hand-edited. Governed by auto-merge readiness.",
    inputs: "An approved, green PR.",
    outputs: "A merged PR.",
    edges: "success → end; blocked → manual merge hold.",
    graphOnly: true,
  },
};

/** Resolve help for a node by its effective kind, or null when none is known
 *  (callers skip rendering the Help section). */
export function nodeHelpFor(kind: WorkflowEditorNodeKind | string): NodeHelp | null {
  return NODE_HELP[kind] ?? null;
}

/** Resolve help for a flow node, honoring the preserved IR kind. */
export function nodeHelpForData(data: WorkflowFlowNodeData): NodeHelp | null {
  return nodeHelpFor(effectiveNodeKind(data));
}
