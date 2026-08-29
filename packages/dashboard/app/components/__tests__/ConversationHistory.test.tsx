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

const multiSelectQuestion: PlanningQuestion = {
  id: "q-tags",
  type: "multi_select",
  question: "Which tags apply?",
  options: [
    { id: "frontend", label: "Frontend" },
    { id: "backend", label: "Backend" },
  ],
};

const confirmQuestion: PlanningQuestion = {
  id: "q-confirm",
  type: "confirm",
  question: "Should Fusion continue?",
};

const markdownQuestion: PlanningQuestion = {
  id: "q-markdown",
  type: "text",
  question: "Do you want **fast** mode?\n\nfirst line  \nsecond line\n\n- Option A\n- Option B",
};

function expectNoObjectObject() {
  expect(screen.queryByText(/\[object Object\]/)).toBeNull();
}

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

  it("renders historical AI questions as sanitized markdown", () => {
    const { container } = render(
      <ConversationHistory
        entries={[{ question: markdownQuestion, response: { "q-markdown": "Yes" } }]}
      />,
    );

    const question = container.querySelector(".conversation-entry-question-text");
    expect(question?.querySelector("strong")).toHaveTextContent("fast");
    expect([...question!.querySelectorAll("p")].find((paragraph) => paragraph.textContent?.includes("first line"))?.querySelector("br")).not.toBeNull();
    expect([...question!.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Option A", "Option B"]);
    expect(question).not.toHaveTextContent("**fast**");
  });

  it("renders single-select Other responses as the user's own answer", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: baseQuestion,
            response: { _other: "my own framing" },
          },
        ]}
      />,
    );

    expect(screen.getByText("my own framing (user's own answer)")).toBeDefined();
    expectNoObjectObject();
  });

  it("renders confirm Other responses as the user's own answer", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: confirmQuestion,
            response: { _other: "Continue only after review" },
          },
        ]}
      />,
    );

    expect(screen.getByText("Continue only after review (user's own answer)")).toBeDefined();
    expectNoObjectObject();
  });

  it("renders multi-select selected labels plus the user's Other answer", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: multiSelectQuestion,
            response: { "q-tags": ["frontend"], _other: "CLI polish" },
          },
        ]}
      />,
    );

    expect(screen.getByText("Frontend, CLI polish (user's own answer)")).toBeDefined();
    expectNoObjectObject();
  });

  it("renders multi-select Other-only responses as the user's own answer", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: multiSelectQuestion,
            response: { _other: "Docs only" },
          },
        ]}
      />,
    );

    expect(screen.getByText("Docs only (user's own answer)")).toBeDefined();
    expectNoObjectObject();
  });

  it("renders Other responses and comments together without treating comments as answers", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: baseQuestion,
            response: { _other: "custom direction", _comment: "Need this done by next sprint" },
          },
        ]}
      />,
    );

    expect(screen.getByText("custom direction (user's own answer)")).toBeDefined();
    expect(screen.getByText("💬 Need this done by next sprint")).toBeDefined();
    expectNoObjectObject();
  });

  it("renders arbitrary object response values as JSON defensively", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: baseQuestion,
            response: { "q-scope": { nested: "value" } },
          },
        ]}
      />,
    );

    expect(screen.getByText('{"nested":"value"}')).toBeDefined();
    expectNoObjectObject();
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

  it("renders comment when response includes _comment", () => {
    render(
      <ConversationHistory
        entries={[
          {
            question: baseQuestion,
            response: { "q-scope": "small", _comment: "Need this done by next sprint" },
          },
        ]}
      />,
    );

    expect(screen.getByText("💬 Need this done by next sprint")).toBeDefined();
  });
});
