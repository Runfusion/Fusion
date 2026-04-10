import { describe, it, expect } from "vitest";
import { isContextLimitError } from "./context-limit-detector.js";

describe("isContextLimitError", () => {
  // ── Positive matches: known provider patterns ──────────────────────

  it("matches Anthropic 'prompt is too long' error", () => {
    expect(isContextLimitError("prompt is too long: 210000 tokens > 200000 maximum")).toBe(true);
  });

  it("matches OpenAI 'exceeds the context window' error", () => {
    expect(isContextLimitError("This model's maximum context length is 128000 tokens. Your input exceeds the context window.")).toBe(true);
  });

  it("matches Google Gemini 'input token count exceeds' error", () => {
    expect(isContextLimitError("input token count exceeds the maximum limit of 1000000")).toBe(true);
  });

  it("matches xAI 'maximum prompt length' error", () => {
    expect(isContextLimitError("maximum prompt length is 131072 but request contains 150000")).toBe(true);
  });

  it("matches Groq 'reduce the length of the messages' error", () => {
    expect(isContextLimitError("Please reduce the length of the messages")).toBe(true);
  });

  it("matches Mistral context length error", () => {
    expect(isContextLimitError("Prompt contains 35000 tokens ... too large for model with 32000 maximum context length")).toBe(true);
  });

  it("matches OpenRouter context length error", () => {
    expect(isContextLimitError("maximum context length is 128000 tokens")).toBe(true);
  });

  it("matches llama.cpp 'exceeds the available context size' error", () => {
    expect(isContextLimitError("attempt to access position 8193 exceeds the available context size")).toBe(true);
  });

  it("matches LM Studio 'greater than the context length' error", () => {
    expect(isContextLimitError("request has 9000 tokens which is greater than the context length of 8192")).toBe(true);
  });

  it("matches Kimi 'exceeded model token limit' error", () => {
    expect(isContextLimitError("exceeded model token limit: 131072 (requested: 150000)")).toBe(true);
  });

  it("matches generic 'context length exceeded'", () => {
    expect(isContextLimitError("context length exceeded")).toBe(true);
  });

  it("matches generic 'context window exceeded'", () => {
    expect(isContextLimitError("context window exceeded")).toBe(true);
  });

  it("matches generic 'context size exceeded'", () => {
    expect(isContextLimitError("context size exceeded")).toBe(true);
  });

  it("matches 'too many tokens'", () => {
    expect(isContextLimitError("too many tokens in request")).toBe(true);
  });

  it("matches Anthropic 'would exceed' variant", () => {
    expect(isContextLimitError("messages with that many tokens would exceed the limit")).toBe(true);
  });

  it("matches 'token limit ... context' pattern", () => {
    expect(isContextLimitError("token limit reached for context window")).toBe(true);
  });

  // ── Provider JSON envelope variants ────────────────────────────────

  it("matches 'context window exceeds limit' variant from provider JSON envelope", () => {
    // This is the specific error from the bug report:
    // 400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"}}
    expect(isContextLimitError("invalid params, context window exceeds limit (2013)")).toBe(true);
  });

  it("matches 'context window exceeds limit' without surrounding text", () => {
    expect(isContextLimitError("context window exceeds limit")).toBe(true);
  });

  it("matches 'context window exceeds limit' with error code", () => {
    expect(isContextLimitError("context window exceeds limit (2003)")).toBe(true);
  });

  it("matches 'context window exceeds' in mixed case", () => {
    expect(isContextLimitError("Context Window Exceeds limit")).toBe(true);
  });

  // ── Negative matches: must NOT trigger ─────────────────────────────

  it("returns false for empty string", () => {
    expect(isContextLimitError("")).toBe(false);
  });

  it("returns false for undefined-ish empty input", () => {
    expect(isContextLimitError("")).toBe(false);
  });

  it("returns false for generic 'Aborted' error", () => {
    expect(isContextLimitError("Aborted")).toBe(false);
  });

  it("returns false for rate limit error", () => {
    expect(isContextLimitError("429 Too Many Requests")).toBe(false);
    expect(isContextLimitError("rate_limit_error: Rate limit exceeded")).toBe(false);
  });

  it("returns false for generic 'limit exceeded' without context keywords", () => {
    expect(isContextLimitError("limit exceeded")).toBe(false);
    expect(isContextLimitError("quota exceeded")).toBe(false);
  });

  it("returns false for server error", () => {
    expect(isContextLimitError("500 Internal Server Error")).toBe(false);
  });

  it("returns false for connection error", () => {
    expect(isContextLimitError("ECONNREFUSED")).toBe(false);
    expect(isContextLimitError("connection refused")).toBe(false);
  });

  it("returns false for usage/billing error", () => {
    expect(isContextLimitError("billing limit reached")).toBe(false);
    expect(isContextLimitError("usage cap exceeded")).toBe(false);
  });

  it("returns false for transient network error", () => {
    expect(isContextLimitError("fetch failed")).toBe(false);
    expect(isContextLimitError("ETIMEDOUT")).toBe(false);
  });

  it("returns false for overloaded error (not context)", () => {
    expect(isContextLimitError("overloaded_error: Overloaded")).toBe(false);
  });
});
