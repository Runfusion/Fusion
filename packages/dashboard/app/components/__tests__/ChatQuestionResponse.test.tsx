import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatQuestionResponse } from "../ChatQuestionResponse";
import type { ParsedQuestionToolCall } from "../../utils/parseQuestionToolCall";
import { clampChatInputHeight, getChatInputAutomaticMaxHeight, getChatInputBoxMetrics } from "../../utils/chatInputAutosize";

const chatQuestionResponseCss = readFileSync(resolve(__dirname, "../ChatQuestionResponse.css"), "utf8");

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

  it("renders an answered read-only summary without leftover live controls", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    try {
      render(<ChatQuestionResponse parsed={parsed} answered submittedAnswer="> Q: Pick one\nAlpha" onSubmit={vi.fn()} />);

      expect(screen.getByText("Answered")).toBeInTheDocument();
      expect(screen.getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("Alpha");
      expect(screen.queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(document.querySelector(".chat-question-response__actions")).toBeNull();
      expect(document.querySelectorAll(".chat-question-response__option")).toHaveLength(0);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("marks the clicked confirm option as visually selected and moves the marker on re-click (FN-7613)", async () => {
    const user = userEvent.setup();
    render(<ChatQuestionResponse parsed={parsed} onSubmit={vi.fn()} />);

    const yesButton = screen.getByTestId("chat-question-response-option-confirm-yes");
    const noButton = screen.getByTestId("chat-question-response-option-confirm-no");

    // Neither selected before any click.
    expect(yesButton).not.toHaveClass("chat-question-response__confirm--selected");
    expect(noButton).not.toHaveClass("chat-question-response__confirm--selected");
    expect(yesButton).toHaveAttribute("aria-pressed", "false");
    expect(noButton).toHaveAttribute("aria-pressed", "false");

    await user.click(yesButton);
    expect(yesButton).toHaveClass("chat-question-response__confirm--selected");
    expect(noButton).not.toHaveClass("chat-question-response__confirm--selected");
    expect(yesButton).toHaveAttribute("aria-pressed", "true");
    expect(noButton).toHaveAttribute("aria-pressed", "false");

    await user.click(noButton);
    expect(noButton).toHaveClass("chat-question-response__confirm--selected");
    expect(yesButton).not.toHaveClass("chat-question-response__confirm--selected");
    expect(noButton).toHaveAttribute("aria-pressed", "true");
    expect(yesButton).toHaveAttribute("aria-pressed", "false");
  });

  it("autosizes independent text answers through five lines and returns each cleared answer to its minimum", async () => {
    const user = userEvent.setup();
    const twoTextQuestions: ParsedQuestionToolCall = {
      questions: [
        { id: "short", type: "text", question: "Short answer" },
        { id: "long", type: "text", question: "Long answer" },
      ],
    };
    render(<ChatQuestionResponse parsed={twoTextQuestions} onSubmit={vi.fn()} />);

    const short = screen.getByTestId("chat-question-response-text-short") as HTMLTextAreaElement;
    const long = screen.getByTestId("chat-question-response-text-long") as HTMLTextAreaElement;
    Object.defineProperty(short, "scrollHeight", { configurable: true, get: () => short.value ? 60 : 24 });
    Object.defineProperty(long, "scrollHeight", { configurable: true, get: () => long.value ? 500 : 24 });

    await user.type(short, "brief");
    await user.type(long, "one\ntwo\nthree\nfour\nfive\nsix");
    expect(short.style.height).toBe(`${clampChatInputHeight(60, getChatInputAutomaticMaxHeight(getChatInputBoxMetrics(short)))}px`);
    expect(long.style.height).toBe(`${clampChatInputHeight(500, getChatInputAutomaticMaxHeight(getChatInputBoxMetrics(long)))}px`);
    expect(long.style.overflowY).toBe("auto");

    await user.clear(long);
    expect(long.style.height).toBe(`${clampChatInputHeight(24, getChatInputAutomaticMaxHeight(getChatInputBoxMetrics(long)))}px`);
    expect(short.style.height).toBe(`${clampChatInputHeight(60, getChatInputAutomaticMaxHeight(getChatInputBoxMetrics(short)))}px`);
  });

  it("uses controller-owned overflow instead of a native resize grip", () => {
    const textareaRule = chatQuestionResponseCss.match(/\.chat-question-response__textarea\s*\{[^}]*\}/)?.[0] ?? "";
    expect(textareaRule).toContain("resize: none");
    expect(textareaRule).toContain("overflow-y: hidden");
    expect(textareaRule).not.toContain("resize: vertical");
  });

  it("supports compact mode", () => {
    render(<ChatQuestionResponse parsed={{ questions: [parsed.questions[0]!] }} compact onSubmit={vi.fn()} />);
    expect(screen.getByTestId("chat-question-response")).toHaveClass("chat-question-response--compact");
  });
});
