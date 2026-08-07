import { describe, expect, it } from "vitest";
import { parsePlanningPlanMd, type PlanningQuestion, type PlanningSummary } from "@fusion/core";
import {
  formatInitialPlanRequestForAgent,
  formatInitialRunningPlanRequestForAgent,
  formatInterviewQA,
  formatPlanningTaskHandoff,
  formatResponseForAgent,
  normalizePlanningSummaryPayload,
} from "../planning";

/*
FNXC:PlanningMode 2026-07-19-01:45:
FN-8341 removed deepen-checkpoint helpers (buildDeepeningCheckpoint*). Keep
formatter coverage for Other answers and core summary normalization only.
*/

const singleSelectQuestion: PlanningQuestion = {
  id: "scope",
  type: "single_select",
  question: "What scope should we plan?",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full launch" },
  ],
};

const multiSelectQuestion: PlanningQuestion = {
  id: "priorities",
  type: "multi_select",
  question: "Which priorities matter?",
  options: [
    { id: "speed", label: "Speed" },
    { id: "quality", label: "Quality" },
  ],
};

const confirmQuestion: PlanningQuestion = {
  id: "proceed",
  type: "confirm",
  question: "Proceed with this plan?",
};

describe("normalizePlanningSummaryPayload", () => {
  it("normalizes core summary fields without deepen themes", () => {
    const summary = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: ["FN-1", "FN-1", ""],
      keyDeliverables: ["Ship"],
    }, { title: "Fallback", description: "Fallback desc" });
    expect(summary.title).toBe("A plan");
    expect(summary.description).toBe("A description");
    expect(summary.suggestedDependencies).toEqual(["FN-1"]);
    expect(summary.keyDeliverables).toEqual(["Ship"]);
    expect(summary).not.toHaveProperty("deepeningThemes");
  });
});

describe("planning interview formatter Other answers", () => {
  it("makes vague openers request inspected, unselected first-level directions", () => {
    for (const prompt of [
      formatInitialPlanRequestForAgent("I don't like the black background"),
      formatInitialRunningPlanRequestForAgent("I don't like the black background"),
    ]) {
      expect(prompt).toMatch(/vague, subjective, preference-based, or symptom-only/i);
      expect(prompt).toMatch(/inspect the relevant implementation surface|Inspect the relevant codebase/i);
      expect(prompt).toMatch(/materially distinct first-level directions|materially distinct direction options/i);
      expect(prompt).toMatch(/unselected direction/i);
      expect(prompt).toMatch(/normally 3–5/i);
      expect(prompt).toMatch(/Two (?:directions|alternatives) are not sufficient/i);
      expect(prompt).toMatch(/include more when genuinely useful|larger set is welcome/i);
      expect(prompt).toMatch(/Other|write-your-own/i);
      expect(prompt).not.toMatch(/exactly four|at least two/i);
    }
  });
  it("formats Other-only single-select answers for the planning agent and Q&A history", () => {
    const response = { scope: "other", _other: "Run discovery first" };
    const agent = formatResponseForAgent(singleSelectQuestion, response);
    const qa = formatInterviewQA([{ question: singleSelectQuestion, response }]);
    expect(agent).toContain("Run discovery first");
    expect(qa).toContain("Run discovery first");
  });

  it("appends Other text to multi-select option labels for the planning agent and Q&A history", () => {
    const response = { priorities: ["speed"], _other: "Keep humans in review" };
    const agent = formatResponseForAgent(multiSelectQuestion, response);
    const qa = formatInterviewQA([{ question: multiSelectQuestion, response }]);
    expect(agent).toMatch(/Speed/);
    expect(agent).toContain("Keep humans in review");
    expect(qa).toContain("Keep humans in review");
  });

  it("formats confirm Yes and No answers without changing boolean semantics", () => {
    expect(formatResponseForAgent(confirmQuestion, { proceed: true })).toMatch(/Yes/i);
    expect(formatInterviewQA([{ question: confirmQuestion, response: { proceed: false } }])).toMatch(/No/i);
  });

  it("formats confirm Other answers and comments as first-class custom answers", () => {
    const response = { _other: "Ask a different scoping question", _comment: "Need more context" };
    const agent = formatResponseForAgent(confirmQuestion, response);
    const qa = formatInterviewQA([{ question: confirmQuestion, response }]);
    expect(agent).toContain("Ask a different scoping question");
    expect(agent).toContain("Need more context");
    expect(qa).toContain("Ask a different scoping question");
    expect(qa).toContain("Need more context");
  });

  it("makes a standard selected option the durable plan backbone before one deeper question", () => {
    const prompt = formatResponseForAgent(singleSelectQuestion, { scope: "mvp" });

    expect(prompt).toContain("Selected: MVP");
    expect(prompt).toMatch(/durable planning decision/i);
    expect(prompt).toMatch(/selected direction is the central intended outcome/i);
    expect(prompt).toMatch(/exactly one next question: a deeper concrete option-driven question/i);
    expect(prompt).toMatch(/only the user can (?:validate|proceed)/i);
  });

  it("carries every multi-select label and verbatim Other steering into the rebuilt plan contract", () => {
    const prompt = formatResponseForAgent(multiSelectQuestion, {
      priorities: ["speed", "quality"],
      _other: "Keep the review checkpoint",
    });

    expect(prompt).toContain("Selected: Speed, Quality, Keep the review checkpoint (user's own answer)");
    expect(prompt).toMatch(/Preserve free-text Other verbatim as steering/i);
    expect(prompt).toMatch(/every accumulated decision/i);
  });
});

describe("planning task handoff formatter", () => {
  const summary: PlanningSummary = {
    title: "Ship planning handoff",
    description: "Preserve the lean plan.",
    suggestedSize: "M",
    suggestedDependencies: [],
    keyDeliverables: ["Persist decisions"],
  };

  it("includes every ordered answer once without mutating the lean summary", () => {
    const longOther = "Long operator decision ".repeat(20);
    const history = [
      { question: singleSelectQuestion, response: { scope: "mvp", _other: longOther, _comment: "Keep this comment" } },
      { question: multiSelectQuestion, response: { priorities: ["speed", "quality"] } },
      { question: confirmQuestion, response: { proceed: true } },
    ];

    const handoff = formatPlanningTaskHandoff(summary, history);
    const qa = formatInterviewQA(history);

    expect(handoff).toContain(qa);
    expect(handoff.match(/## Planning Interview Context/g)).toHaveLength(1);
    expect(handoff).toContain("MVP");
    expect(handoff).toContain("Speed, Quality");
    expect(handoff).toContain("Yes");
    expect(handoff).toContain(longOther);
    expect(handoff).toContain("Keep this comment");
    expect(summary.description).toBe("Preserve the lean plan.");
    expect(parsePlanningPlanMd(handoff)).toMatchObject({
      title: summary.title,
      description: expect.stringContaining(longOther),
    });
    expect(formatPlanningTaskHandoff({ ...summary, description: `${summary.description}\n\n${qa}` }, history).match(/## Planning Interview Context/g)).toHaveLength(1);
  });

  it("keeps empty interview handoffs canonical without an empty context shell", () => {
    const handoff = formatPlanningTaskHandoff(summary, []);
    expect(handoff).not.toContain("Planning Interview Context");
    expect(parsePlanningPlanMd(handoff)).toMatchObject({ description: summary.description });
  });
});
