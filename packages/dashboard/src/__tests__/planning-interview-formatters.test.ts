import { describe, expect, it } from "vitest";
import {
  PLANNING_DEEPEN_CHECKPOINT_ID,
  PLANNING_DEEPEN_CHECKPOINT_QUESTION,
  PLANNING_DEEPEN_PROCEED_OPTION_ID,
} from "@fusion/core";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import {
  buildDeepeningCheckpointOptions,
  buildDeepeningCheckpointQuestion,
  classifyDeepeningCheckpointResponse,
  formatInterviewQA,
  formatResponseForAgent,
} from "../planning";

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

const summaryWithSurfaces: PlanningSummary = {
  title: "Improve mobile UX testing",
  description: "Handle empty and duplicate data states for a responsive mobile workflow.",
  suggestedSize: "M",
  suggestedDependencies: [],
  keyDeliverables: ["Add keyboard UX", "Verify regression tests"],
};

describe("planning deepening checkpoint helpers", () => {
  it("builds the mandatory checkpoint question with deterministic proceed and inferred theme options", () => {
    const question = buildDeepeningCheckpointQuestion(
      [{ question: multiSelectQuestion, response: { priorities: ["quality"] } }],
      summaryWithSurfaces,
    );

    expect(question.id).toBe(PLANNING_DEEPEN_CHECKPOINT_ID);
    expect(question.question).toBe(PLANNING_DEEPEN_CHECKPOINT_QUESTION);
    expect(question.type).toBe("multi_select");
    expect(question.options?.[0]?.id).toBe(PLANNING_DEEPEN_PROCEED_OPTION_ID);
    expect(question.options?.map((option) => option.label)).toEqual([
      "Proceed to final plan",
      "Edge cases and data states",
      "UX and interaction details",
      "Testing and verification",
    ]);
  });

  it("falls back to safe default themes when no conversation themes are inferred", () => {
    const options = buildDeepeningCheckpointOptions([], {
      title: "Tiny task",
      description: "Do the thing.",
      suggestedSize: "S",
      suggestedDependencies: [],
      keyDeliverables: [],
    });

    expect(options?.map((option) => option.label)).toEqual([
      "Proceed to final plan",
      "Scope and non-goals",
      "Edge cases and data states",
      "UX and interaction details",
      "Testing and verification",
    ]);
  });

  it("classifies proceed separately from selected themes and custom topics", () => {
    const question = buildDeepeningCheckpointQuestion([], summaryWithSurfaces);

    expect(classifyDeepeningCheckpointResponse(question, {
      [question.id]: [PLANNING_DEEPEN_PROCEED_OPTION_ID],
    })).toMatchObject({ proceed: true, selectedThemeLabels: [] });

    expect(classifyDeepeningCheckpointResponse(question, {
      [question.id]: ["theme-testing"],
      _other: "Explore rollout risk",
    })).toMatchObject({
      proceed: false,
      selectedThemeIds: ["theme-testing"],
      selectedThemeLabels: ["Testing and verification"],
      customTopic: "Explore rollout risk",
    });
  });
});

describe("planning interview formatter Other answers", () => {
  it("formats Other-only single-select answers for the planning agent and Q&A history", () => {
    const response = { _other: "Run discovery first" };

    expect(formatResponseForAgent(singleSelectQuestion, response)).toContain(
      "Selected: Run discovery first (user's own answer)",
    );
    expect(formatInterviewQA([{ question: singleSelectQuestion, response }])).toContain(
      "A: Run discovery first (user's own answer)",
    );
  });

  it("appends Other text to multi-select option labels for the planning agent and Q&A history", () => {
    const response = { priorities: ["speed"], _other: "Keep humans in review" };

    expect(formatResponseForAgent(multiSelectQuestion, response)).toContain(
      "Selected: Speed, Keep humans in review (user's own answer)",
    );
    expect(formatInterviewQA([{ question: multiSelectQuestion, response }])).toContain(
      "A: Speed, Keep humans in review (user's own answer)",
    );
  });

  it("formats confirm Yes and No answers without changing boolean semantics", () => {
    expect(formatResponseForAgent(confirmQuestion, { proceed: true })).toContain("Answer: Yes");
    expect(formatInterviewQA([{ question: confirmQuestion, response: { proceed: true } }])).toContain("A: Yes");

    expect(formatResponseForAgent(confirmQuestion, { proceed: false })).toContain("Answer: No");
    expect(formatInterviewQA([{ question: confirmQuestion, response: { proceed: false } }])).toContain("A: No");
  });

  it("formats confirm Other answers and comments as first-class custom answers", () => {
    const response = { _other: "Ask a different scoping question", _comment: "Need product input" };

    expect(formatResponseForAgent(confirmQuestion, response)).toContain(
      "Answer: Ask a different scoping question (user's own answer)",
    );
    expect(formatResponseForAgent(confirmQuestion, response)).toContain("Additional context: Need product input");
    expect(formatInterviewQA([{ question: confirmQuestion, response }])).toContain(
      "A: Ask a different scoping question (user's own answer)",
    );
    expect(formatInterviewQA([{ question: confirmQuestion, response }])).toContain("Comment: Need product input");
  });
});
