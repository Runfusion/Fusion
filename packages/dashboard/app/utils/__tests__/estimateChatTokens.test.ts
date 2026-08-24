import { describe, expect, it } from "vitest";
import { estimateChatTokens, formatTokenCount } from "../estimateChatTokens";

describe("estimateChatTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateChatTokens([])).toBe(0);
  });

  it("sums multiple message contents with a four-character heuristic", () => {
    expect(estimateChatTokens([{ content: "abcd" }, { content: "abcdefgh" }])).toBe(3);
  });

  it("includes streaming text in the estimate", () => {
    expect(estimateChatTokens([{ content: "abcd" }], "abcdefgh")).toBe(3);
  });

  it("guards against null or undefined content", () => {
    expect(estimateChatTokens([{ content: null }, {}, { content: "abcde" }])).toBe(2);
  });

  it("includes thinking and tool payloads per message without throwing on circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateChatTokens([{ content: "abcd", thinkingOutput: "abcd", toolCalls: [{ toolName: "read", args: { path: "a" }, result: circular }] }])).toBe(6);
  });
});

describe("formatTokenCount", () => {
  it("renders sub-1k counts without a suffix", () => {
    expect(formatTokenCount(980)).toBe("980");
  });

  it("renders one-decimal compact thousands below 10k", () => {
    expect(formatTokenCount(1234)).toBe("~1.2k");
  });

  it("rounds larger thousands without a decimal", () => {
    expect(formatTokenCount(200_000)).toBe("200k");
  });

  it("omits the approximate marker for measured values", () => {
    expect(formatTokenCount(1234, { approximate: false })).toBe("1.2k");
  });
});
