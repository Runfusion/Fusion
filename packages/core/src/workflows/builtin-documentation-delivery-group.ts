import type { WorkflowIrNode } from "./workflow-ir-types.js";

export const DOCUMENTATION_DELIVERY_GROUP_ID = "documentation-delivery";

/*
FNXC:DocumentationMilestone 2026-08-25-10:20:
This milestone reports on accepted work; it does NOT write the repository and does NOT judge.

Repository documentation belongs to the EXECUTOR during implementation: a docs change is a code
change, and writing it here put it outside the diff the reviewer approved — the exact content-drift
the review seal exists to prevent, which is why this node used to be forced ahead of the review it
was authored to follow. Whether the change warrants a docs update is the executor's judgement, not a
mandatory stage.

FNXC:DocumentationMilestone 2026-08-26-07:34:
IT HAD NO WRITER, AND ITS PROMPT DID NOT KNOW THAT.

The previous prompt asked for four tool calls — `fn_task_done(summary=…)`,
`fn_task_document_write`, `fn_artifact_register`, and creating follow-up tasks. A workflow-step
session with `toolMode: "readonly"` is limited to `read/grep/find/ls`, `fn_web_fetch`, and a few
read-only task reads (`workflow-step-tool-policy.ts`); `fn_task_create` is explicitly DENIED there.
So the milestone could perform NONE of them. It ran, produced a well-formed report every time, and
persisted nothing — and because it also replaced `completion-summary`, which DID work, cards silently
lost their agent-authored summary and fell back to the deterministic backfill. This is the same
failure the reviewer prompt was fixed for ("do not claim you ran the tests"), on another node.

Both durable outputs now travel by PROJECTION, the one channel a readonly node actually has:
`summaryTarget: "task"` persists its prose as the card summary (the contract completion-summary
used), and `recommendationsTarget: "task"` persists a trailing JSON payload as task recommendations.

Recommendations, not tasks, is the deliberate shape: an in-review agent must never create board
rows. Proposals land in the task's Recommendations tab, where an OPERATOR turns the ones worth doing
into tasks. That is already the rule the executor follows at completion; this milestone now shares it.

`summaryTarget` additionally removes the verdict requirement for this node
(`execute-workflow-step.ts` `isSummaryProjectionStep`), so a reporter can no longer emit the REVISE
that used to hold the merge door and bounce the card.
*/
const DOCUMENTATION_DELIVERY_PROMPT = `Report on the accepted implementation exactly once, for the operator who reads this card later.

You have NO writer. This session can read, search and list — nothing else. Everything durable you
produce is the text you output here. Do not call a tool to save it, do not claim you saved anything,
and do not modify repository files: the code has already been reviewed and must not change now.

## 1. The card summary (always)

Open with 2-4 sentences of plain prose an operator can read to know what shipped and why. Mention
user-visible behaviour or important files when they matter, and how it was verified. No headings, no
bullet lists, no process narration, no verdict. This text becomes the task's summary.

## 2. Follow-up proposals (only when they genuinely exist)

If the work surfaced worthwhile follow-up ideas OUTSIDE this task's scope, end your output with one
fenced JSON block, and nothing after it:

\`\`\`json
{"recommendations":[{"id":"stable-slug","title":"short title","description":"what to do and why","category":"improvement"}]}
\`\`\`

- \`category\` is one of: improvement, feature, bug, other.
- Each \`id\` must be unique and stable.
- These are PROPOSALS for a human, not work orders and not tasks: an operator decides which become
  tasks. You cannot create tasks and must not try.
- Ground every entry in something you actually saw. Omit the block entirely rather than invent work,
  restate this task, or pad the list. Fewer, real proposals are the correct answer.
- Never put commands, shell syntax, credentials or secrets in a proposal.

You cannot block this card and you have no verdict to give. If something is missing or you could not
determine it, say so plainly in the summary and finish.`;

export function documentationDeliveryOptionalGroupNode(column: string): WorkflowIrNode {
  return {
    id: DOCUMENTATION_DELIVERY_GROUP_ID,
    kind: "optional-group",
    column,
    config: {
      name: "Documentation",
      defaultOn: true,
      /*
      FNXC:ReportingOnlyGroup 2026-08-26-06:56:
      Documentation ONLY documents. `gateMode: "advisory"` on the inner node was not enough and the
      gap was measured on a real card: its REVISE recorded `advisory_failure`, which held the merge
      door ("no current approval") AND bounced the card to implementation with no work to do, where
      it re-ran Code Review against an unchanged tree and merged on the second pass by luck.
      `reportingOnly` states the contract once: no approval to withhold, no remediation to request.
      */
      reportingOnly: true,
      template: {
        nodes: [{
          id: "documentation-delivery-step",
          kind: "prompt",
          config: {
            name: "Documentation",
            prompt: DOCUMENTATION_DELIVERY_PROMPT,
            toolMode: "readonly",
            gateMode: "advisory",
            workflowAction: "documentation-delivery",
            /* The two projection contracts that give a writer-less node durable output. */
            summaryTarget: "task",
            recommendationsTarget: "task",
          },
        }],
        edges: [],
      },
    },
  };
}
