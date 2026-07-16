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
  normalizePlanningSummaryPayload,
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
    expect(question.planPreview).toEqual({
      title: summaryWithSurfaces.title,
      description: summaryWithSurfaces.description,
      keyDeliverables: summaryWithSurfaces.keyDeliverables,
    });
  });

  it("includes an empty deliverables preview instead of an unchecked payload", () => {
    const question = buildDeepeningCheckpointQuestion([], {
      ...summaryWithSurfaces,
      keyDeliverables: [],
    });

    expect(question.planPreview).toEqual({
      title: summaryWithSurfaces.title,
      description: summaryWithSurfaces.description,
      keyDeliverables: [],
    });
    expect(question.options?.[0]?.id).toBe(PLANNING_DEEPEN_PROCEED_OPTION_ID);
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

  it("prefers AI-authored deepeningThemes over the generic regex themes, keeping proceed first", () => {
    const summaryWithAiThemes: PlanningSummary = {
      ...summaryWithSurfaces,
      deepeningThemes: [
        { label: "Offline sync conflicts", description: "How do concurrent edits reconcile without a server round trip?" },
        { label: "Push notification budget", description: "Does this plan's notification volume need throttling?" },
      ],
    };

    const question = buildDeepeningCheckpointQuestion([], summaryWithAiThemes);

    expect(question.options?.[0]?.id).toBe(PLANNING_DEEPEN_PROCEED_OPTION_ID);
    expect(question.options?.map((option) => option.label)).toEqual([
      "Proceed to final plan",
      "Offline sync conflicts",
      "Push notification budget",
    ]);
    expect(question.options?.[1]?.description).toBe("How do concurrent edits reconcile without a server round trip?");
  });

  it("falls back to the generic regex themes when deepeningThemes is absent or empty", () => {
    const withoutThemes = buildDeepeningCheckpointOptions([], summaryWithSurfaces);
    expect(withoutThemes?.map((option) => option.label)).toEqual([
      "Proceed to final plan",
      "Edge cases and data states",
      "UX and interaction details",
      "Testing and verification",
    ]);

    const withEmptyThemes = buildDeepeningCheckpointOptions([], { ...summaryWithSurfaces, deepeningThemes: [] });
    expect(withEmptyThemes?.map((option) => option.label)).toEqual([
      "Proceed to final plan",
      "Edge cases and data states",
      "UX and interaction details",
      "Testing and verification",
    ]);
  });

  it("excludes an AI theme colliding with the reserved proceed option, keeping proceed unique and first", () => {
    const summaryWithCollidingTheme: PlanningSummary = {
      ...summaryWithSurfaces,
      deepeningThemes: [
        { label: "Proceed to final plan", description: "Should be dropped as a collision." },
        { label: "Data retention window", description: "How long should archived records live?" },
      ],
    };

    const options = buildDeepeningCheckpointOptions([], summaryWithCollidingTheme);
    expect(options?.map((option) => option.label)).toEqual([
      "Proceed to final plan",
      "Data retention window",
    ]);
    expect(options?.filter((option) => option.id === PLANNING_DEEPEN_PROCEED_OPTION_ID)).toHaveLength(1);
  });

  it("resolves an AI-sourced theme id to its label via classifyDeepeningCheckpointResponse", () => {
    const summaryWithAiThemes: PlanningSummary = {
      ...summaryWithSurfaces,
      deepeningThemes: [{ label: "Offline sync conflicts" }],
    };
    const question = buildDeepeningCheckpointQuestion([], summaryWithAiThemes);
    const themeOptionId = question.options?.[1]?.id as string;

    expect(classifyDeepeningCheckpointResponse(question, {
      [question.id]: [themeOptionId],
      _other: "Also check billing edge cases",
    })).toMatchObject({
      proceed: false,
      selectedThemeLabels: ["Offline sync conflicts"],
      customTopic: "Also check billing edge cases",
    });

    expect(classifyDeepeningCheckpointResponse(question, {
      [question.id]: [PLANNING_DEEPEN_PROCEED_OPTION_ID],
    })).toMatchObject({ proceed: true, selectedThemeLabels: [] });
  });
});

describe("normalizePlanningSummaryPayload deepeningThemes normalization", () => {
  const baseFallback = { title: "Fallback title", description: "Fallback description" };

  it("keeps valid entries, trims label/description, and dedupes case-insensitively", () => {
    const summary = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      deepeningThemes: [
        { label: "  Offline sync  ", description: "  Handle conflicts  " },
        { label: "offline sync" },
      ],
    }, baseFallback);

    expect(summary.deepeningThemes).toEqual([
      { label: "Offline sync", description: "Handle conflicts" },
    ]);
  });

  it("drops malformed entries (missing/blank label, non-object, non-array) without throwing", () => {
    const summary = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      deepeningThemes: [
        { label: "   " },
        { description: "missing label" },
        "not-an-object",
        null,
        42,
        { label: "Valid theme" },
      ],
    }, baseFallback);

    expect(summary.deepeningThemes).toEqual([{ label: "Valid theme" }]);

    const summaryWithNonArray = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      deepeningThemes: "not-an-array",
    }, baseFallback);
    expect(summaryWithNonArray.deepeningThemes).toBeUndefined();
  });

  it("omits the field entirely (not []) when absent or all entries are invalid", () => {
    const withoutField = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
    }, baseFallback);
    expect("deepeningThemes" in withoutField).toBe(false);

    const withEmptyArray = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      deepeningThemes: [],
    }, baseFallback);
    expect("deepeningThemes" in withEmptyArray).toBe(false);

    const withAllInvalid = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      deepeningThemes: [{ label: "" }, { notALabel: true }],
    }, baseFallback);
    expect("deepeningThemes" in withAllInvalid).toBe(false);
  });

  it("caps the number of themes kept", () => {
    const themes = Array.from({ length: 10 }, (_, index) => ({ label: `Theme ${index}` }));
    const summary = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      deepeningThemes: themes,
    }, baseFallback);

    expect(summary.deepeningThemes).toHaveLength(6);
    expect(summary.deepeningThemes?.[0]).toEqual({ label: "Theme 0" });
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
