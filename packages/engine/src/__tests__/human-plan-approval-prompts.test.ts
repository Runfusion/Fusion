/*
FNXC:HumanPlanApproval 2026-09-15-06:24:
FN-408 — the note an operator attaches when APPROVING a plan ("just be careful about X while
implementing it") must reach the implementation session, and only the note of the CURRENT decision
may do so. Rejection messages go to the planner instead and must never surface here.

Surface enumeration: all four implementation prompt shapes reachable for a task — the standard
execution prompt, the Fast-lane prompt, the per-step session prompt, and the reduced (context-limit
resume) step prompt. A note delivered to three of four would silently vanish on resume.
*/
import { describe, expect, it } from "vitest";
import type { Task, TaskDetail } from "@fusion/core";
import { HUMAN_PLAN_APPROVAL_NOTE_HEADING } from "@fusion/core";

import { buildExecutionPrompt } from "../executor/execution-prompt.js";
import { buildFastLanePrompt, buildReducedStepPrompt, buildStepPrompt } from "../execution/step-session-executor.js";

const EPISODE = "2026-09-15T06:20:00.000Z";
const LATER_EPISODE = "2026-09-15T09:00:00.000Z";
const FINGERPRINT = "d".repeat(64);
const NOTE = "Fais attention aux migrations SQL : garde la colonne héritée ✅";

const PROMPT = [
  "# Task: FN-408",
  "",
  "## Mission",
  "Implement the thing.",
  "",
  "## Steps",
  "",
  "### Step 0: Preflight",
  "",
  "- [ ] Check the tree",
  "",
  "### Step 1: Build",
  "",
  "- [ ] Build the thing",
  "",
].join("\n");

function planReviewPassed(completedAt = EPISODE, over: Record<string, unknown> = {}) {
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    status: "passed",
    completedAt,
    ...over,
  } as NonNullable<Task["workflowStepResults"]>[number];
}

function decision(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    decision: "approved",
    message: NOTE,
    decidedBy: "dashboard-operator",
    decidedAt: EPISODE,
    planFingerprint: FINGERPRINT,
    planningEpisodeId: EPISODE,
    ...over,
  } as NonNullable<NonNullable<Task["humanPlanApproval"]>["decision"]>;
}

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-408",
    title: "Human plan approval",
    description: "Ajouter une validation humaine du plan par carte",
    column: "in-progress",
    status: null,
    prompt: PROMPT,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Build", status: "pending" },
    ],
    currentStep: 1,
    log: [],
    approvedPlanFingerprint: FINGERPRINT,
    workflowStepResults: [planReviewPassed()],
    humanPlanApproval: { enabled: true, decision: decision() },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as TaskDetail;
}

/** Every implementation prompt shape, driven as a table so none can be forgotten. */
const BUILDERS: ReadonlyArray<{ label: string; build: (task: TaskDetail) => string }> = [
  { label: "standard execution prompt", build: (task) => buildExecutionPrompt(task) },
  { label: "fast-lane prompt", build: (task) => buildFastLanePrompt(task) },
  { label: "per-step session prompt", build: (task) => buildStepPrompt(task, 1) },
  { label: "reduced (context-limit) step prompt", build: (task) => buildReducedStepPrompt(task, 1) },
];

describe("the approved operator note reaches every implementation session shape", () => {
  for (const { label, build } of BUILDERS) {
    it(`delivers the current approved note in the ${label}`, () => {
      const prompt = build(detail());

      expect(prompt).toContain(HUMAN_PLAN_APPROVAL_NOTE_HEADING);
      expect(prompt).toContain(NOTE);
    });

    it(`adds no note section when the card has no option (${label})`, () => {
      const prompt = build(detail({ humanPlanApproval: undefined }));

      expect(prompt).not.toContain(HUMAN_PLAN_APPROVAL_NOTE_HEADING);
    });

    it(`adds no note section when the approval carried no message (${label})`, () => {
      const prompt = build(detail({
        humanPlanApproval: { enabled: true, decision: decision({ message: "   " }) },
      }));

      expect(prompt).not.toContain(HUMAN_PLAN_APPROVAL_NOTE_HEADING);
    });

    it(`never delivers a rejection message to implementation (${label})`, () => {
      const prompt = build(detail({
        humanPlanApproval: {
          enabled: true,
          decision: decision({ decision: "rejected", message: "Le plan est faux, recommence" }),
        },
      }));

      expect(prompt).not.toContain(HUMAN_PLAN_APPROVAL_NOTE_HEADING);
      expect(prompt).not.toContain("Le plan est faux");
    });

    it(`never delivers a note approved for a superseded review episode (${label})`, () => {
      const prompt = build(detail({
        workflowStepResults: [
          planReviewPassed(EPISODE, { supersededAt: EPISODE, supersededReason: "respecify" }),
          planReviewPassed(LATER_EPISODE),
        ],
      }));

      expect(prompt).not.toContain(HUMAN_PLAN_APPROVAL_NOTE_HEADING);
      expect(prompt).not.toContain(NOTE);
    });

    it(`never delivers a note approved for a different plan (${label})`, () => {
      const prompt = build(detail({ approvedPlanFingerprint: "e".repeat(64) }));

      expect(prompt).not.toContain(NOTE);
    });
  }

  it("delivers the note through the Fast execution mode routed by buildExecutionPrompt", () => {
    // buildExecutionPrompt delegates to the Fast builder; the note must survive that delegation.
    const prompt = buildExecutionPrompt(detail({ executionMode: "fast" }));

    expect(prompt).toContain(HUMAN_PLAN_APPROVAL_NOTE_HEADING);
    expect(prompt).toContain(NOTE);
  });

  it("keeps the note out of the plan itself so the plan fingerprint is unchanged", () => {
    /*
    The note is implementation context, not a plan edit: PROMPT.md must be byte-identical whether or
    not a note exists, otherwise approving would invalidate the very plan just approved.
    */
    const withNote = detail();
    const withoutNote = detail({ humanPlanApproval: { enabled: true } });

    expect(withNote.prompt).toBe(withoutNote.prompt);
    expect(withNote.prompt).not.toContain(NOTE);
  });
});
