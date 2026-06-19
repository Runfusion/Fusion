import { describe, expect, it } from "vitest";
import type { ToolCallInfo } from "../../hooks/chatTypes";
import { formatQuestionAnswer, isQuestionToolName, parseQuestionToolCall } from "../parseQuestionToolCall";

function toolCall(toolName: string, args?: Record<string, unknown>): ToolCallInfo {
  return { toolName, args, isError: false, status: "completed" };
}

describe("parseQuestionToolCall", () => {
  it("recognizes question tool names case-insensitively", () => {
    expect(isQuestionToolName("AskUserQuestion")).toBe(true);
    expect(isQuestionToolName("ASK_USER")).toBe(true);
    expect(isQuestionToolName("fn_ask_question")).toBe(true);
    expect(isQuestionToolName("grep")).toBe(false);
  });

  it("normalizes Claude AskUserQuestion multi-question args", () => {
    const parsed = parseQuestionToolCall(toolCall("AskUserQuestion", {
      questions: [
        { question: "Pick one", header: "Decision", options: [{ label: "A" }, { label: "B", description: "Bee" }] },
        { id: "features", question: "Pick many", options: [{ id: "x", label: "X" }, { label: "Y" }], multiSelect: true },
      ],
    }));

    expect(parsed).toEqual({
      questions: [
        {
          id: "q-0",
          type: "single_select",
          question: "Pick one",
          header: "Decision",
          description: undefined,
          options: [{ id: "opt-0", label: "A", description: undefined }, { id: "opt-1", label: "B", description: "Bee" }],
          multiSelect: undefined,
        },
        {
          id: "features",
          type: "multi_select",
          question: "Pick many",
          header: undefined,
          description: undefined,
          options: [{ id: "x", label: "X", description: undefined }, { id: "opt-1", label: "Y", description: undefined }],
          multiSelect: true,
        },
      ],
    });
  });

  it.each([
    ["ask_user", { question: "Continue?", options: ["Yes", "No"] }, "confirm"],
    ["request_user_input", { prompt: "Name?" }, "text"],
    ["elicit", { message: "Choose", choices: [{ value: "a", label: "Alpha" }] }, "single_select"],
    ["ask_followup_question", { question: "Boolean?", type: "boolean" }, "confirm"],
  ] as const)("normalizes %s common schema", (name, args, expectedType) => {
    const parsed = parseQuestionToolCall(toolCall(name, args));
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0]?.type).toBe(expectedType);
    expect(parsed?.questions[0]?.id).toBe("q-0");
  });

  it("normalizes fn_ask_question across all supported question types", () => {
    const parsed = parseQuestionToolCall(toolCall("fn_ask_question", {
      questions: [
        { question: "Pick one", type: "single_select", options: [{ label: "Alpha" }] },
        { question: "Pick many", type: "multi_select", options: [{ label: "Beta", description: "Second" }] },
        { question: "Explain", type: "text", description: "Short answer is fine." },
        { question: "Proceed?", type: "confirm" },
      ],
    }));

    expect(parsed?.questions).toEqual([
      expect.objectContaining({ id: "q-0", type: "single_select", question: "Pick one", options: [{ id: "opt-0", label: "Alpha", description: undefined }] }),
      expect.objectContaining({ id: "q-1", type: "multi_select", question: "Pick many", multiSelect: true, options: [{ id: "opt-0", label: "Beta", description: "Second" }] }),
      expect.objectContaining({ id: "q-2", type: "text", question: "Explain", description: "Short answer is fine." }),
      expect.objectContaining({ id: "q-3", type: "confirm", question: "Proceed?" }),
    ]);
  });

  it("falls back for malformed, empty option select, and non-question tools", () => {
    expect(parseQuestionToolCall(toolCall("ask_user"))).toBeNull();
    expect(parseQuestionToolCall(toolCall("ask_user", { question: "" }))).toBeNull();
    expect(parseQuestionToolCall(toolCall("ask_user", { question: "Pick", type: "single_select", options: [] }))).toBeNull();
    expect(parseQuestionToolCall(toolCall("read", { question: "No" }))).toBeNull();
  });

  it("formats selected labels, text, and confirm answers", () => {
    const parsed = parseQuestionToolCall(toolCall("AskUserQuestion", {
      questions: [
        { id: "one", question: "Pick one", options: [{ id: "a", label: "Alpha" }] },
        { id: "many", question: "Pick many", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], multiSelect: true },
        { id: "text", question: "Explain" },
        { id: "ok", question: "Proceed?", type: "confirm" },
      ],
    }));

    expect(parsed).not.toBeNull();
    expect(formatQuestionAnswer(parsed!.questions, { one: "a", many: ["x", "y"], text: "Because", ok: false })).toBe(
      "> Q: Pick one\nAlpha\n\n> Q: Pick many\nX, Y\n\n> Q: Explain\nBecause\n\n> Q: Proceed?\nNo",
    );
  });
});
