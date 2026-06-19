import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatQuestionResponse } from "../ChatQuestionResponse";
import type { ParsedQuestionToolCall } from "../../utils/parseQuestionToolCall";

const parsed: ParsedQuestionToolCall = {
  questions: [
    { id: "single", type: "single_select", question: "Pick one", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta", description: "Second" }] },
    { id: "multi", type: "multi_select", question: "Pick many", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
    { id: "text", type: "text", question: "Explain" },
    { id: "confirm", type: "confirm", question: "Proceed?" },
  ],
};

describe("ChatQuestionResponse", () => {
  it("renders all question controls and validates before submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ChatQuestionResponse parsed={parsed} onSubmit={onSubmit} />);

    expect(screen.getByTestId("chat-question-response")).toBeInTheDocument();
    const submit = screen.getByTestId("chat-question-response-submit");
    expect(submit).toBeDisabled();

    await user.click(screen.getByTestId("chat-question-response-option-single-a"));
    await user.click(screen.getByTestId("chat-question-response-option-multi-x"));
    await user.type(screen.getByTestId("chat-question-response-text-text"), "Need the safe path");
    await user.click(screen.getByTestId("chat-question-response-option-confirm-yes"));

    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith(
      "> Q: Pick one\nAlpha\n\n> Q: Pick many\nX\n\n> Q: Explain\nNeed the safe path\n\n> Q: Proceed?\nYes",
      { single: "a", multi: ["x"], text: "Need the safe path", confirm: true },
    );
  });

  it("renders an answered read-only summary", () => {
    render(<ChatQuestionResponse parsed={parsed} answered submittedAnswer="> Q: Pick one\nAlpha" onSubmit={vi.fn()} />);

    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(screen.getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("Alpha");
    expect(screen.queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
  });

  it("supports compact mode", () => {
    render(<ChatQuestionResponse parsed={{ questions: [parsed.questions[0]!] }} compact onSubmit={vi.fn()} />);
    expect(screen.getByTestId("chat-question-response")).toHaveClass("chat-question-response--compact");
  });
});
