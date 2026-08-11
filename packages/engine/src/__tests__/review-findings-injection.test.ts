import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Task, WorkflowReviewFinding } from "@fusion/core";

import {
  injectReviewAdvisoryNotes,
  injectWorkflowStepFailureInstructions,
} from "../executor/workflow-step-failure-injection.js";

/*
FNXC:ReviewSeverityGate 2026-08-10-17:33:
These pin the IMPLEMENTER-FACING contract of the severity work. The gate only pays off if the
implementer can tell a blocking defect from an optional note: before this, remediation injected one
undifferentiated prose blob, so every observation read as mandatory and a single REVISE turned into a
multi-round negotiation. Assert the priority grouping, the explicit obligations, and the sanctioned
decline path — those are the behaviors that make the loop converge.
*/

const task = { id: "FN-TEST" } as Task;

let dir: string;
let promptPath: string;

const store = {
  getFusionDir: () => dir,
};

function finding(overrides: Partial<WorkflowReviewFinding>): WorkflowReviewFinding {
  return { id: "f", title: "t", body: "b", ...overrides };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fusion-review-injection-"));
  await mkdir(join(dir, "tasks", task.id), { recursive: true });
  promptPath = join(dir, "tasks", task.id, "PROMPT.md");
  await writeFile(promptPath, "# Task\n\nOriginal plan body.\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("injectWorkflowStepFailureInstructions", () => {
  it("renders findings grouped by priority with per-group obligations", async () => {
    await injectWorkflowStepFailureInstructions(
      store,
      task,
      "prose feedback",
      "Code Review",
      { attempt: 1, max: 3 },
      [
        finding({ id: "a", title: "null deref", body: "crashes", severity: "critical", filePath: "src/a.ts", line: 9 }),
        finding({ id: "b", title: "weak test", body: "no coverage", severity: "high" }),
        finding({ id: "c", title: "naming", body: "minor", severity: "low" }),
      ],
    );

    const content = await readFile(promptPath, "utf-8");
    expect(content).toContain("## Workflow Step Failure");
    expect(content).toContain("### P0 — must fix");
    expect(content).toContain("### P1 — should fix");
    expect(content).toContain("### P2 — optional");
    expect(content).toContain("src/a.ts:9");
    // The decline path is what lets a disputed finding terminate instead of ping-ponging.
    expect(content).toContain("a recorded decline is a valid resolution");
    expect(content).toContain("P2 items are optional");
    // Structured findings REPLACE the prose blob rather than appearing alongside it.
    expect(content).not.toContain("prose feedback");
    expect(content).toContain("Original plan body.");
  });

  it("keeps receipts out of actionable findings while preserving a do-not-redo audit block", async () => {
    await injectWorkflowStepFailureInstructions(
      store,
      task,
      "prose feedback",
      "Code Review",
      { attempt: 1, max: 3 },
      [
        finding({ id: "o1", title: "Open finding", body: "Implement this", severity: "high" }),
        finding({ id: "r1", title: "Receipt", body: "Fixed: already committed", severity: "critical", resolution: "resolved-in-review" }),
        finding({ id: "c1", title: "Earlier lane", body: "No longer applies", resolution: "superseded" }),
      ],
    );

    const content = await readFile(promptPath, "utf-8");
    expect(content).toContain("Open finding");
    expect(content).toContain("Already resolved during this review pass — do NOT redo");
    expect(content).toContain("Fixed: already committed");
    expect(content).toContain("No longer applies");
    expect(content.indexOf("Open finding")).toBeLessThan(content.indexOf("Already resolved during this review pass"));
  });

  it("falls back to prose feedback when the step produced no structured findings", async () => {
    await injectWorkflowStepFailureInstructions(store, task, "prose feedback", "Verification", { attempt: 1, max: 2 });

    const content = await readFile(promptPath, "utf-8");
    expect(content).toContain("**Failure Feedback:**");
    expect(content).toContain("prose feedback");
    expect(content).not.toContain("### P0 — must fix");
  });

  it("replaces its own section instead of appending on a second remediation round", async () => {
    await injectWorkflowStepFailureInstructions(store, task, "first", "Code Review", { attempt: 1, max: 3 });
    await injectWorkflowStepFailureInstructions(store, task, "second", "Code Review", { attempt: 2, max: 3 });

    const content = await readFile(promptPath, "utf-8");
    expect(content.match(/## Workflow Step Failure/g)).toHaveLength(1);
    expect(content).toContain("second");
    expect(content).not.toContain("first");
  });
});

describe("injectReviewAdvisoryNotes", () => {
  it("labels downgraded findings as non-blocking and requiring no remediation", async () => {
    await injectReviewAdvisoryNotes(store, task, "Plan Review", [
      finding({ id: "a", title: "consider caching", body: "optional", severity: "medium" }),
    ]);

    const content = await readFile(promptPath, "utf-8");
    expect(content).toContain("## Review Advisory Notes");
    expect(content).toContain("NON-BLOCKING");
    expect(content).toContain("require no remediation round");
    expect(content).toContain("### P2 — optional");
    expect(content).toContain("Original plan body.");
  });

  it("replaces its own section across repeated reviews so PROMPT.md cannot grow without bound", async () => {
    await injectReviewAdvisoryNotes(store, task, "Plan Review", [finding({ title: "first note", body: "x", severity: "low" })]);
    await injectReviewAdvisoryNotes(store, task, "Plan Review", [finding({ title: "second note", body: "y", severity: "low" })]);

    const content = await readFile(promptPath, "utf-8");
    expect(content.match(/## Review Advisory Notes/g)).toHaveLength(1);
    expect(content).toContain("second note");
    expect(content).not.toContain("first note");
  });

  it("is a no-op when there are no advisory findings", async () => {
    const before = await readFile(promptPath, "utf-8");
    await injectReviewAdvisoryNotes(store, task, "Plan Review", []);
    expect(await readFile(promptPath, "utf-8")).toBe(before);
  });

  it("does not throw when PROMPT.md is absent", async () => {
    await rm(promptPath);
    await expect(
      injectReviewAdvisoryNotes(store, task, "Plan Review", [finding({ severity: "low" })]),
    ).resolves.toBeUndefined();
  });
});
