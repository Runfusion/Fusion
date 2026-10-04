import type { WorkflowIrNode } from "./workflow-ir-types.js";

/*
FNXC:WorkflowPostMerge 2026-06-26-09:00:
Factory for a POST-MERGE optional-group node — the graph-native execution mechanism
for post-merge workflow steps (U7 spike). Mirrors `codeReviewOptionalGroupNode` /
`browserVerificationOptionalGroupNode`, but the produced node carries
`config.phase: "post-merge"` so the graph executor:
  1. runs it only AFTER a successful merge (when wired off the merge region and the
     `graphNativePostMerge` flag is on), and
  2. records its WorkflowStepResult with `phase: "post-merge"` + emits `[post-merge]`
     logs. Advisory post-merge failures are non-blocking; explicit gate-mode
     verification failures block final graph success after merge proof.

FNXC:WorkflowPostMerge 2026-06-29-12:22:
Full task built-ins need an explicit default-off post-merge verification node so
post-merge audit/verification policy can live in workflow definitions instead of
merger-only fallback code. The group node id is the STABLE per-task enable key
(`enabledWorkflowSteps`), and the inner template node carries a DISTINCT id
(`${id}-step`) — a template node id may not collide with the group/top-level node id
(optional-group validation).
*/

export const POST_MERGE_VERIFICATION_GROUP_ID = "post-merge-verification";

const LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS = ["plan-review", "code-review"] as const;
const BUILTIN_CODING_WORKFLOW_IDS = new Set([
  "builtin:coding",
  "builtin:legacy-coding",
  "builtin:stepwise-coding",
]);

/**
 * FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:41:
 * Upgrade the historical built-in coding default with the mandatory post-merge
 * delivery-evidence gate. Only the exact former default is changed; every other
 * optional-step configuration retains its recorded shape.
 */
export function upgradeLegacyCodingPostMergeVerificationStepIds(
  workflowId: string,
  stepIds: readonly string[],
): string[] | undefined {
  if (!BUILTIN_CODING_WORKFLOW_IDS.has(workflowId)
    || stepIds.length !== LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS.length
    || !LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS.every((id) => stepIds.includes(id))) {
    return undefined;
  }

  /*
  FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:41:
  The former two-review default predates the required post-landing Full Suite evidence gate.
  Migrate only that exact inherited profile when it is next authoritatively resolved, preserving
  intentional optional-step configurations while preventing existing default coding tasks from
  completing without the five-lane CI evidence required by FN-9369.
  */
  return [...LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS, POST_MERGE_VERIFICATION_GROUP_ID];
}

/*
FNXC:PostMergeFullSuiteEvidence 2026-09-22-01:36:
An enabled post-merge gate owns the task's required post-landing Full Suite evidence. CI remains
non-blocking branch protection, but this gate must refuse final task completion until the first
push-to-main run at or after the landed SHA has recorded every shard conclusion and timing artifact.

FNXC:ReviewRecovery 2026-10-04-02:24:
FN-9375 retained failed-lane evidence for explicit disposition. Requiring green non-blocking lanes
contradicts that policy and strands every unrelated landed task; require honest disposition instead.
*/
const POST_MERGE_VERIFICATION_PROMPT = `You are a post-merge verification reviewer. Verify that the task's merged result is safe after integration.

## Review focus
1. Confirm the task has merge proof or already-on-main proof before treating the workflow as complete.
2. Check the final merged diff and task summary for obvious mismatches, missing verification evidence, or integration-only regressions.
3. If configured test/build commands are available in the task context, inspect their latest result or explain why no post-merge command was applicable.

## Publish the evidence you verify
You own collecting and recording the evidence, not only checking whether another agent already recorded it.
1. Use fn_task_document_read to list the task documents, then read the existing delivery record. Preserve its contents; if none exists, create a document with key="delivery".
2. Collect the required run, lane, artifact, and failure evidence below. Search existing tasks with fn_task_search or fn_task_list and inspect matches with fn_task_show before creating any follow-up. Link an existing task when it covers the failure; otherwise use fn_task_create for ordinary follow-up work, without creating a mission.
3. Save the verified evidence and follow-up links using fn_task_document_write. For an existing document, pass its expected_revision from the read. If publication reports a conflict, re-read and explicitly rebase the update; never overwrite newer evidence blindly.
4. Return your verdict only after publication succeeds. Missing delivery prose is work for this session, not by itself a reason to return REVISE. If task creation is unavailable or requires operator validation, record that exact limitation and any proposed follow-up, and return REVISE when a required follow-up still has no task ID.
Do not edit product code or the task plan after landing. An actual regression requires follow-up implementation and remains blocking until its resolution is verified.

## Required post-landing Full Suite evidence
This enabled gate requires post-landing Full Suite evidence. Do NOT approve until its delivery record names all of the following:
1. The landed SHA and the first Full Suite push-to-main run at or after that SHA, including the run ID and run SHA.
2. The completed conclusion for Pipeline smoke tier.
3. The completed conclusion for every Test shard: 1/4, 2/4, 3/4, and 4/4.
4. All four timing artifacts: test-timings-shard-1, test-timings-shard-2, test-timings-shard-3, and test-timings-shard-4.

Full Suite and Pipeline smoke are non-blocking signals. A failed lane requires an explicit evidence-backed disposition in the delivery record: identify the actual failures from the logs and the post-merge-full-suite-evidence artifact, establish whether this task introduced them, and link the existing or newly created follow-up task for unrelated failures. Never fabricate success, dismiss an unexplained failure as pre-existing, or approve an unresolved regression introduced by this task. Completed red lanes with documented, supported dispositions may receive APPROVE_WITH_NOTES.

Judge failures against this task's landed changes. For evidence-backed unrelated failures, a linked follow-up with an accountable owner satisfies the disposition requirement; that follow-up may still be open, running, or failed. Do not require unrelated follow-up completion, disposition of the entire repository backlog, or a green non-blocking Full Suite before approving this task. You must perform this task's attribution from the available diff, logs, and failure artifact rather than defer it wholesale to the follow-up. If attribution remains unknown, name the specific failure and missing evidence that prevents the decision; a red shard count or an open follow-up alone is not a task regression.

Pre-landing, unrelated-main, or partial evidence does not satisfy this contract. If the required run is still running or required evidence is unavailable, return REVISE and state that final completion remains blocked pending the post-landing evidence. Record verified evidence and every non-success disposition in the task delivery record before approving.

## Output Requirements
- APPROVE: post-merge verification is acceptable.
- APPROVE_WITH_NOTES: completion may proceed with non-blocking notes only when every post-landing evidence item above is recorded.
- REVISE: completion should be blocked; include the concrete post-merge issue and the needed follow-up.
- \`notes\` MUST contain one to three non-empty sentences naming what was checked and why the verdict was reached. An empty \`notes\` string is a protocol violation.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

export interface PostMergeOptionalGroupSpec {
  /** Stable per-task enable key + group node id. */
  id: string;
  /** Display name (toggle/editor surfaces + recorded `workflowStepName`). */
  name: string;
  /** Column the group node sits in (typically a post-merge/`done` column). */
  column: string;
  /** Agent prompt for the inner post-merge step. */
  prompt: string;
  /** Optional short description for the inner node. */
  description?: string;
  /** Inner step tool access; defaults to "readonly". */
  toolMode?: "readonly" | "coding";
  /** Gate semantics; defaults to "advisory" (post-merge failures are non-blocking). */
  gateMode?: "advisory" | "gate";
  /** Seed the per-task enable toggle for new tasks; defaults to false (opt-in). */
  defaultOn?: boolean;
}

/**
 * Build a post-merge `optional-group` node. The node config is marked
 * `phase: "post-merge"` so the graph executor's optional-group recording path keys
 * the result phase + log prefix off it.
 */
export function postMergeOptionalGroupNode(spec: PostMergeOptionalGroupSpec): WorkflowIrNode {
  return {
    id: spec.id,
    kind: "optional-group",
    column: spec.column,
    config: {
      name: spec.name,
      phase: "post-merge",
      defaultOn: spec.defaultOn ?? false,
      template: {
        nodes: [
          {
            id: `${spec.id}-step`,
            kind: "prompt",
            config: {
              name: spec.name,
              ...(spec.description !== undefined ? { description: spec.description } : {}),
              prompt: spec.prompt,
              toolMode: spec.toolMode ?? "readonly",
              gateMode: spec.gateMode ?? "advisory",
            },
          },
        ],
        edges: [],
      },
    },
  };
}

export function postMergeVerificationOptionalGroupNode(column = "done"): WorkflowIrNode {
  return postMergeOptionalGroupNode({
    id: POST_MERGE_VERIFICATION_GROUP_ID,
    name: "Post-merge verification",
    column,
    prompt: POST_MERGE_VERIFICATION_PROMPT,
    description: "Verify the integrated result after merge proof before final completion",
    gateMode: "gate",
    /*
    FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:04:
    Post-merge evidence is a delivery boundary, not an advisory observation. Seed this gate for
    merge-capable built-ins so completion cannot claim GitHub-hosted Full Suite success before the
    landed run has proved Pipeline smoke, every shard, and each timing artifact.
    */
    defaultOn: true,
  });
}
