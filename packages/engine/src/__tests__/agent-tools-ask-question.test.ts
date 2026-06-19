import { describe, expect, it } from "vitest";
import { createAskQuestionTool } from "../agent-tools.js";

describe("createAskQuestionTool", () => {
  async function execute(params: Parameters<ReturnType<typeof createAskQuestionTool>["execute"]>[1]) {
    const tool = createAskQuestionTool();
    return tool.execute("call-1", params, undefined as never, undefined as never, undefined as never);
  }

  it("creates the fn_ask_question tool", () => {
    const tool = createAskQuestionTool();

    expect(tool.name).toBe("fn_ask_question");
    expect(tool.label).toBe("Ask User Question");
  });

  it("accepts valid single-question and multi-question payloads and tells the agent to wait", async () => {
    const single = await execute({
      questions: [{ question: "Which path should I take?", type: "single_select", options: [{ label: "A" }] }],
    });
    expect(single.isError).not.toBe(true);
    expect(single.details).toEqual({ questionCount: 1 });
    expect(single.content[0]?.type === "text" ? single.content[0].text : "").toContain("Stop and wait");

    const multi = await execute({
      questions: [
        { question: "Explain the goal", type: "text" },
        { question: "Proceed?", type: "confirm" },
      ],
    });
    expect(multi.isError).not.toBe(true);
    expect(multi.details).toEqual({ questionCount: 2 });
    expect(multi.content[0]?.type === "text" ? multi.content[0].text : "").toContain("next turn");
  });

  it("accepts text and confirm questions without options", async () => {
    const text = await execute({ questions: [{ question: "What should I call it?", type: "text" }] });
    const confirm = await execute({ questions: [{ question: "Should I continue?", type: "confirm" }] });

    expect(text.isError).not.toBe(true);
    expect(confirm.isError).not.toBe(true);
  });

  it("rejects empty question lists, blank question text, and optionless select questions", async () => {
    await expect(execute({ questions: [] })).resolves.toMatchObject({ isError: true });
    await expect(execute({ questions: [{ question: "   ", type: "text" }] })).resolves.toMatchObject({ isError: true });
    await expect(execute({ questions: [{ question: "Pick one", type: "single_select" }] })).resolves.toMatchObject({ isError: true });
    await expect(execute({ questions: [{ question: "Pick many", type: "multi_select", options: [] }] })).resolves.toMatchObject({ isError: true });
    await expect(execute({ questions: [{ question: "Pick many", multiSelect: true }] })).resolves.toMatchObject({ isError: true });
  });
});
