import { describe, expect, it } from "vitest";
import { parseJsonOutput, parseLine } from "../stream-parser.js";

/*
FNXC:GrokCli 2026-07-10-12:53:
FN-7796: fixtures pin the reliable xAI Grok Build TUI headless contract, `--output-format json`, because live `streaming-json` intermittently ended `stopReason:"Cancelled"` without text. Keep one streaming parser regression for the captured cancelled shape so diagnostics stay concrete if the flaky shape appears in buffered output.
*/

describe("parseJsonOutput (xAI Grok CLI json)", () => {
  it("parses the reliable single-object response", () => {
    const output = JSON.stringify({
      text: "Hello",
      stopReason: "EndTurn",
      sessionId: "session-1",
      requestId: "request-1",
      thought: "Thinking",
    });
    expect(parseJsonOutput(output)).toEqual({
      text: "Hello",
      stopReason: "EndTurn",
      sessionId: "session-1",
      requestId: "request-1",
      thought: "Thinking",
    });
  });

  it("tolerates pretty-printed json from the real CLI", () => {
    const output = `\n{\n  "text": "Hello",\n  "stopReason": "EndTurn",\n  "sessionId": "session-1",\n  "requestId": "request-1",\n  "thought": "Thinking"\n}\n`;
    expect(parseJsonOutput(output)?.text).toBe("Hello");
  });

  it("preserves a terminal empty EndTurn object", () => {
    expect(parseJsonOutput(JSON.stringify({ text: "", stopReason: "EndTurn" }))).toEqual({
      text: "",
      stopReason: "EndTurn",
      sessionId: undefined,
      requestId: undefined,
      thought: undefined,
    });
  });

  it("skips empty, non-JSON, malformed JSON, arrays, and unrelated objects without throwing", () => {
    expect(parseJsonOutput("")).toBeNull();
    expect(parseJsonOutput("Welcome to grok interactive mode")).toBeNull();
    expect(() => parseJsonOutput("{not valid json")).not.toThrow();
    expect(parseJsonOutput("{not valid json")).toBeNull();
    expect(parseJsonOutput(JSON.stringify([{ text: "hi" }]))).toBeNull();
    expect(parseJsonOutput(JSON.stringify({ type: "step_start" }))).toBeNull();
  });
});

describe("parseLine (captured flaky streaming-json diagnostics)", () => {
  it("parses the cancelled no-text terminal shape", () => {
    const line = JSON.stringify({
      type: "end",
      stopReason: "Cancelled",
      sessionId: "session-1",
      requestId: "request-1",
    });
    expect(parseLine(line)).toEqual({
      type: "end",
      stopReason: "Cancelled",
      sessionId: "session-1",
      requestId: "request-1",
    });
  });

  it("parses thought/text events for buffered streaming regressions", () => {
    expect(parseLine(JSON.stringify({ type: "thought", data: "Thinking" }))).toEqual({ type: "thought", data: "Thinking" });
    expect(parseLine(JSON.stringify({ type: "text", data: "Hello" }))).toEqual({ type: "text", data: "Hello" });
  });

  it("skips malformed, unknown, and legacy wrong-product lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("[SandboxDebug] booting")).toBeNull();
    expect(parseLine("{not valid json")).toBeNull();
    expect(parseLine(JSON.stringify({ type: "step_start", stepNumber: 1 }))).toBeNull();
    expect(parseLine(JSON.stringify([{ type: "text", data: "hi" }]))).toBeNull();
  });
});
