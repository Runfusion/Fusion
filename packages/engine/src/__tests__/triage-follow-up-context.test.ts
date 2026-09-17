/*
FNXC:TaskFollowUp 2026-09-17-16:10:
FN-513 Step 4 — the parent context a follow-up's planner receives, and how it is assembled into the
REAL `buildSpecificationPrompt` output.

The distinction these cases keep enforcing is "the source's plan is BACKGROUND" versus "the source's
plan is this task's specification input". They are adjacent in the prompt and trivially confusable,
and confusing them is how B would be planned as a re-implementation of A.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail } from "@fusion/core";
import {
  FOLLOW_UP_PLAN_CHAR_BUDGET,
  formatFollowUpContextUnavailableSection,
  formatFollowUpParentContextSection,
  loadFollowUpParentContext,
  planLooksLikeSeed,
  type FollowUpContextStore,
  type FollowUpParentContext,
} from "../triage-domain/follow-up-context.js";
import { buildSpecificationPrompt } from "../triage.js";

const FOLLOW_UP_MARKER = { followUp: { version: 1 } };

function followUpChild(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-B",
    title: "Add a CSV export",
    description: "Add a CSV export\n\nFollows up on: FN-A",
    column: "todo",
    dependencies: ["FN-A"],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    columnMovedAt: "2026-09-17T10:00:00.000Z",
    sourceType: "task_refine",
    sourceParentTaskId: "FN-A",
    sourceMetadata: FOLLOW_UP_MARKER,
    ...overrides,
  } as Task;
}

const REAL_PLAN = [
  "# Task: FN-A — Build the importer",
  "",
  "## Mission",
  "Build a streaming row importer with a pluggable column mapper.",
  "",
  "## Steps",
  "",
  "### Step 0: Preflight",
  "- [ ] confirm the fixtures",
  "",
  "### Step 1: Streaming reader",
  "- [ ] add the pluggable column mapper capability",
].join("\n");

function parentDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-A",
    title: "Build the importer",
    description: "Import rows from a spreadsheet",
    column: "in-progress",
    status: null,
    dependencies: [],
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Streaming reader", status: "pending" },
    ],
    stepReports: [
      { id: "r1", stepIndex: 0, stepName: "Preflight", summary: "Confirmed the fixtures and the parser entry point.", recordedAt: "2026-09-17T09:00:00.000Z", source: "agent", attempt: 1 },
    ],
    modifiedFiles: ["packages/core/src/importer.ts"],
    branch: "fusion/fn-a",
    currentStep: 1,
    createdAt: "2026-09-17T08:00:00.000Z",
    updatedAt: "2026-09-17T09:00:00.000Z",
    columnMovedAt: "2026-09-17T08:00:00.000Z",
    prompt: REAL_PLAN,
    ...overrides,
  } as TaskDetail;
}

function storeWith(parent: TaskDetail | null | undefined, options: { throws?: unknown } = {}): FollowUpContextStore {
  const read = vi.fn(async () => {
    if (options.throws) throw options.throws;
    return parent;
  });
  return { getTask: read, getTaskDetail: read } as unknown as FollowUpContextStore;
}

describe("planLooksLikeSeed", () => {
  it("treats an absent, blank, or seed-shaped prompt as not-a-plan", () => {
    expect(planLooksLikeSeed(undefined)).toBe(true);
    expect(planLooksLikeSeed("   ")).toBe(true);
    expect(planLooksLikeSeed("# FN-A: Build the importer\n\nImport rows from a spreadsheet\n")).toBe(true);
  });

  it("recognizes a real specification by any of its structural sections", () => {
    expect(planLooksLikeSeed(REAL_PLAN)).toBe(false);
    expect(planLooksLikeSeed("# x\n\n## File Scope\n- a.ts")).toBe(false);
    expect(planLooksLikeSeed("# x\n\n## Completion Criteria\n- done")).toBe(false);
  });
});

describe("loadFollowUpParentContext", () => {
  it("ignores an ordinary task, an ordinary refinement, and a malformed marker", async () => {
    const store = storeWith(parentDetail());
    for (const task of [
      { sourceType: "dashboard" } as Task,
      { sourceType: "task_refine", sourceParentTaskId: "FN-A" } as Task,
      { sourceType: "task_refine", sourceParentTaskId: "FN-A", sourceMetadata: { followUp: { version: 2 } } } as Task,
      { sourceType: "task_refine", sourceMetadata: FOLLOW_UP_MARKER } as Task,
    ]) {
      expect(await loadFollowUpParentContext(store, task)).toEqual({ kind: "not-a-follow-up" });
    }
    expect(store.getTask).not.toHaveBeenCalled();
  });

  it("loads the source's plan, steps, reports, files and delivery references", async () => {
    const outcome = await loadFollowUpParentContext(storeWith(parentDetail()), followUpChild());
    expect(outcome.kind).toBe("loaded");
    const context = (outcome as { context: FollowUpParentContext }).context;
    expect(context.parentTaskId).toBe("FN-A");
    expect(context.plan).toBe(REAL_PLAN);
    expect(context.planIsSeedOrAbsent).toBe(false);
    expect(context.steps).toEqual([
      { name: "Preflight", status: "done" },
      { name: "Streaming reader", status: "pending" },
    ]);
    expect(context.stepReports).toEqual([
      { stepName: "Preflight", summary: "Confirmed the fixtures and the parser entry point.", recordedAt: "2026-09-17T09:00:00.000Z" },
    ]);
    expect(context.modifiedFiles).toEqual(["packages/core/src/importer.ts"]);
    expect(context.deliveryReferences).toContain("branch fusion/fn-a");
  });

  it("names a seed plan as a seed instead of carrying it as a plan", async () => {
    const outcome = await loadFollowUpParentContext(
      storeWith(parentDetail({ prompt: "# FN-A: Build the importer\n\nImport rows\n" })),
      followUpChild(),
    );
    const context = (outcome as { context: FollowUpParentContext }).context;
    expect(context.plan).toBeUndefined();
    expect(context.planIsSeedOrAbsent).toBe(true);
    // The description and reports remain usable even without a plan.
    expect(context.parentDescription).toBe("Import rows from a spreadsheet");
    expect(context.stepReports).toHaveLength(1);
  });

  it("distinguishes a missing parent, a deleted parent, and a read FAILURE", async () => {
    expect(await loadFollowUpParentContext(storeWith(null), followUpChild()))
      .toEqual({ kind: "unavailable", reason: "parent-missing" });
    expect(await loadFollowUpParentContext(storeWith(parentDetail({ deletedAt: "2026-09-17T09:30:00.000Z" })), followUpChild()))
      .toEqual({ kind: "unavailable", reason: "parent-deleted" });

    const transportFailure = new Error("connection terminated unexpectedly");
    const failed = await loadFollowUpParentContext(storeWith(parentDetail(), { throws: transportFailure }), followUpChild());
    // A transport failure must NEVER be flattened into "no context" — that plans B against silence.
    expect(failed).toEqual({ kind: "failed", error: transportFailure });
  });

  it("re-reads the source on every call rather than caching it between planning attempts", async () => {
    let column = "in-progress";
    let prompt = REAL_PLAN;
    const store = {
      getTask: vi.fn(async () => parentDetail({ column, prompt })),
      getTaskDetail: vi.fn(async () => parentDetail({ column, prompt })),
    } as unknown as FollowUpContextStore;

    const first = await loadFollowUpParentContext(store, followUpChild());
    expect((first as { context: FollowUpParentContext }).context.parentColumn).toBe("in-progress");

    column = "done";
    prompt = `${REAL_PLAN}\n\n### Step 2: Export hook\n- [ ] added later`;
    const second = await loadFollowUpParentContext(store, followUpChild());
    const secondContext = (second as { context: FollowUpParentContext }).context;
    // A source that has FINISHED still supplies context: the live rule only gates CREATION.
    expect(secondContext.parentColumn).toBe("done");
    expect(secondContext.plan).toContain("Export hook");
  });
});

describe("formatFollowUpParentContextSection", () => {
  async function render(parent: TaskDetail): Promise<string> {
    const outcome = await loadFollowUpParentContext(storeWith(parent), followUpChild());
    return formatFollowUpParentContextSection((outcome as { context: FollowUpParentContext }).context);
  }

  it("renders the source identity, snapshot instant, plan, steps and reports as distinct facts", async () => {
    const section = await render(parentDetail());
    expect(section).toContain("FOLLOW-UP of **FN-A**");
    expect(section).toContain("Snapshot read at");
    expect(section).toContain("Source lane: in-progress");
    expect(section).toContain("pluggable column mapper");
    expect(section).toContain("[done] Preflight");
    expect(section).toContain("[pending] Streaming reader");
    expect(section).toContain("Confirmed the fixtures");
    expect(section).toContain("packages/core/src/importer.ts");
    // The incomplete step is explicitly NOT presented as delivered.
    expect(section).toContain("incomplete steps are NOT delivered");
    expect(section).toContain("Specify only the DELTA");
    expect(section).toContain("Keep the dependency on FN-A");
    expect(section).toContain("fn_task_show FN-A");
  });

  it("names an absent plan as an unplanned seed rather than calling it approved", async () => {
    const section = await render(parentDetail({ prompt: "# FN-A: Build the importer\n\nImport rows\n" }));
    expect(section).toContain("NO specification yet");
    expect(section).toContain("unplanned seed");
    expect(section).toContain("Do not describe it as planned or approved");
    // No plan block is rendered at all, so there is nothing that could read as an approved plan.
    expect(section).not.toContain("### Source plan (its PROMPT.md)");
  });

  it("truncates a very large plan and points at the full artifact", async () => {
    const huge = `${REAL_PLAN}\n${"x".repeat(FOLLOW_UP_PLAN_CHAR_BUDGET + 5_000)}`;
    const section = await render(parentDetail({ prompt: huge }));
    expect(section).toContain("[TRUNCATED —");
    expect(section).toContain("fn_task_show FN-A");
    expect(section.length).toBeLessThan(huge.length);
  });

  /*
  A parent plan routinely contains its own fenced code blocks. A fixed three-backtick fence would be
  closed by the first of them, splicing the rest of the source's plan into the instruction stream.
  */
  it("survives nested Markdown fences inside the source plan", async () => {
    const nested = [
      "## Mission",
      "Explain the format.",
      "",
      "````markdown",
      "```ts",
      "const a = 1;",
      "```",
      "````",
    ].join("\n");
    const section = await render(parentDetail({ prompt: nested }));
    const lines = section.split("\n");
    const planHeadingIndex = lines.indexOf("### Source plan (its PROMPT.md)");
    expect(planHeadingIndex).toBeGreaterThan(-1);
    const openingFence = lines.slice(planHeadingIndex).find((line) => /^`{3,}markdown$/.test(line))!;
    // The chosen fence is strictly longer than the longest backtick run it must contain (4).
    expect(openingFence.replace("markdown", "").length).toBeGreaterThan(4);
    // The whole nested payload survives inside that fence rather than being cut at its first ```.
    expect(section).toContain("const a = 1;");
    expect(section.slice(section.indexOf(openingFence) + openingFence.length)).toContain("````");
  });

  it("reports an unavailable parent explicitly and forbids substituting a similarly named task", () => {
    const section = formatFollowUpContextUnavailableSection("FN-A", "parent-deleted");
    expect(section).toContain("UNAVAILABLE (parent-deleted)");
    expect(section).toContain("do not substitute a similarly named task");
    expect(section).not.toContain("Source plan (its PROMPT.md)");
  });
});

/*
FNXC:TaskFollowUp 2026-09-17-16:10:
Assembly through the REAL prompt builder. The point is separation: the source block, this task's own
request, its Original Description and its plan.md input must remain four distinguishable things.
*/
describe("buildSpecificationPrompt with follow-up parent context", () => {
  const childDetail = {
    id: "FN-B",
    title: "Add a CSV export",
    description: "Add a CSV export for the imported rows",
    column: "todo",
    dependencies: ["FN-A"],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    columnMovedAt: "2026-09-17T10:00:00.000Z",
    attachments: [],
    comments: [],
  } as unknown as TaskDetail;

  it("carries the source block while keeping this task's own request distinct", async () => {
    const outcome = await loadFollowUpParentContext(storeWith(parentDetail()), followUpChild());
    const section = formatFollowUpParentContextSection((outcome as { context: FollowUpParentContext }).context);

    const prompt = buildSpecificationPrompt(
      childDetail,
      "/tmp/FN-B/PROMPT.md",
      {} as never,
      [],
      undefined,
      undefined,
      { originalDescription: "Add a CSV export for the imported rows", followUpParentContext: section },
    );

    expect(prompt).toContain("## Source Task Context (follow-up)");
    expect(prompt).toContain("pluggable column mapper");
    // This task's own request is still its own, and still verbatim under Original Request.
    expect(prompt).toContain("## Original Request");
    expect(prompt).toContain("Add a CSV export for the imported rows");
    // The source block is background, placed before the planner's instructions.
    expect(prompt.indexOf("## Source Task Context (follow-up)")).toBeLessThan(prompt.indexOf("## Instructions"));
  });

  it("keeps the source block separate from a Planning Mode plan.md input", async () => {
    const outcome = await loadFollowUpParentContext(storeWith(parentDetail()), followUpChild());
    const section = formatFollowUpParentContextSection((outcome as { context: FollowUpParentContext }).context);

    const prompt = buildSpecificationPrompt(
      childDetail,
      "/tmp/FN-B/PROMPT.md",
      {} as never,
      [],
      undefined,
      undefined,
      { plan: "# B's own lean plan\n\nExport the rows.", originalDescription: "Add a CSV export", followUpParentContext: section },
    );

    expect(prompt).toContain("## Planning Mode plan.md");
    expect(prompt).toContain("B's own lean plan");
    expect(prompt).toContain("## Source Task Context (follow-up)");
    // Two different blocks, with the source's plan never presented as this task's specification input.
    expect(prompt.indexOf("## Planning Mode plan.md")).toBeLessThan(prompt.indexOf("## Source Task Context (follow-up)"));
  });

  it("omits the section entirely for an ordinary task", () => {
    const prompt = buildSpecificationPrompt(
      childDetail,
      "/tmp/FN-B/PROMPT.md",
      {} as never,
      [],
      undefined,
      undefined,
      { originalDescription: "Add a CSV export" },
    );
    expect(prompt).not.toContain("## Source Task Context (follow-up)");
    expect(prompt).not.toContain("FOLLOW-UP of");
  });
});
