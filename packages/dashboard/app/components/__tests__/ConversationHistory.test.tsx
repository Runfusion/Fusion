import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PlanningQuestion } from "@fusion/core";
import { ConversationHistory } from "../ConversationHistory";

const baseQuestion: PlanningQuestion = {
  id: "q-scope",
  type: "single_select",
  question: "What is the project scope?",
  options: [
    { id: "small", label: "Small" },
    { id: "medium", label: "Medium" },
  ],
};

describe("ConversationHistory", () => {
  it("renders question and formatted response pairs", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: baseQuestion,
            response: { "q-scope": "medium" },
          },
        ]}
      />,
    );

    expect(screen.getByText("Q1")).toBeDefined();
    expect(screen.getByText("What is the project scope?")).toBeDefined();
    expect(screen.getByText("Medium")).toBeDefined();
  });

  it("shows thinking output when expanded", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: { ...baseQuestion, id: "q1" },
            response: { q1: "small" },
            thinkingOutput: "Internal reasoning for first question",
          },
        ]}
      />,
    );

    expect(screen.queryByText("Internal reasoning for first question")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show AI thinking/i }));

    expect(screen.getByText("Internal reasoning for first question")).toBeDefined();
  });

  it("returns null for empty entries", () => {
    const { container } = render(<ConversationHistory entries={[]} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders entries that only contain thinking output", () => {
    render(
      <ConversationHistory
        entries={[
          {
            thinkingOutput: "Reasoning captured during subtask generation",
          },
        ]}
      />,
    );

    expect(screen.getByText("AI Reasoning")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Show AI reasoning/i }));
    expect(screen.getByText("Reasoning captured during subtask generation")).toBeDefined();
  });
});
