import { describe, expect, it } from "vitest";
import {
  applyReasoningSummaryToPayload,
  isReasoningSummaryUnsupportedError,
} from "../reasoning-summary-payload.js";

const responsesApis = ["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const;
const nonResponsesApis = [
  "anthropic-messages",
  "openai-completions",
  "google-generative-ai",
  "bedrock-converse-stream",
  "mistral-conversations",
  "pi-messages",
] as const;

describe("applyReasoningSummaryToPayload", () => {
  it.each(responsesApis)("upgrades an enabled %s request while preserving effort", (api) => {
    const payload = { reasoning: { effort: "medium", summary: "auto" }, input: "keep" };

    expect(applyReasoningSummaryToPayload(payload, { api }, "detailed")).toEqual({
      reasoning: { effort: "medium", summary: "detailed" },
      input: "keep",
    });
  });

  it.each(nonResponsesApis)("leaves %s payloads byte-identical", (api) => {
    const payload = { reasoning: { effort: "high", summary: "auto" }, input: "keep" };

    expect(applyReasoningSummaryToPayload(payload, { api }, "detailed")).toBeUndefined();
  });

  it("adds detailed only to an enabled request whose summary is absent", () => {
    const payload = { reasoning: { effort: "high" } };

    expect(applyReasoningSummaryToPayload(payload, { api: "openai-responses" }, "detailed")).toEqual({
      reasoning: { effort: "high", summary: "detailed" },
    });
  });

  it.each([
    ["missing reasoning", { input: "keep" }],
    ["thinking disabled", { reasoning: { effort: "none" } }],
    ["existing detailed summary", { reasoning: { effort: "high", summary: "detailed" } }],
    ["explicit concise summary", { reasoning: { effort: "high", summary: "concise" } }],
    ["null payload", null],
    ["string payload", "payload"],
    ["array payload", []],
    ["string reasoning", { reasoning: "high" }],
    ["null reasoning", { reasoning: null }],
  ])("does not alter %s", (_name, payload) => {
    expect(applyReasoningSummaryToPayload(payload, { api: "openai-responses" }, "detailed")).toBeUndefined();
  });

  it("does not mutate either the request or its reasoning object", () => {
    const reasoning = { effort: "medium", summary: "auto" };
    const payload = { reasoning, input: "keep" };

    const result = applyReasoningSummaryToPayload(payload, { api: "openai-responses" }, "detailed");

    expect(payload).toEqual({ reasoning: { effort: "medium", summary: "auto" }, input: "keep" });
    expect(result).not.toBe(payload);
    expect(result?.reasoning).not.toBe(reasoning);
  });

  it("treats auto and off detail as no-op requests", () => {
    const payload = { reasoning: { effort: "medium", summary: "auto" } };

    expect(applyReasoningSummaryToPayload(payload, { api: "openai-responses" }, "auto")).toBeUndefined();
    expect(applyReasoningSummaryToPayload(payload, { api: "openai-responses" }, "off")).toBeUndefined();
  });

  it("can deliberately request concise without overriding an explicit choice", () => {
    const payload = { reasoning: { effort: "medium", summary: "auto" } };

    expect(applyReasoningSummaryToPayload(payload, { api: "openai-responses" }, "concise")).toEqual({
      reasoning: { effort: "medium", summary: "concise" },
    });
  });
});

describe("isReasoningSummaryUnsupportedError", () => {
  it.each([
    "Unsupported reasoning summary: detailed",
    "reasoning_summary is invalid for this model",
    "Unknown reasoning summary option",
    "Summary reasoning is not supported by this endpoint",
  ])("recognizes an explicit summary capability rejection: %s", (message) => {
    expect(isReasoningSummaryUnsupportedError(message)).toBe(true);
  });

  it.each([
    "400 Bad Request",
    "maximum context length exceeded",
    "invalid API key",
    "cannot specify both thinking and reasoning_effort",
    "reasoning effort is unsupported",
    "summary field is invalid",
  ])("does not misclassify unrelated provider errors: %s", (message) => {
    expect(isReasoningSummaryUnsupportedError(message)).toBe(false);
  });
});
