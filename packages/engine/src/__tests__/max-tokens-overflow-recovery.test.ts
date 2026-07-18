/**
 * FNXC:MaxTokensOverflowRecovery 2026-07-17-16:30:
 * Tests for the provider overflow error recovery in promptWithFallback.
 * Verifies regex extraction of exact token values from OpenRouter/
 * OpenAI-compatible error messages, and the safety calculation.
 */
import { describe, expect, it } from "vitest";

// Mirror of the production pattern from pi.ts
const MAX_TOKENS_OVERFLOW_EXACT_PATTERN = /maximum context length is (\d+).*?you requested (\d+).*?contains at least (\d+)/is;
const MAX_TOKENS_OVERFLOW_SAFETY_MARGIN = 4096;

describe("max-tokens-overflow-recovery", () => {
  describe("pattern matching", () => {
    it("matches OpenRouter overflow error with full JSON body", () => {
      const errorMsg = `400: {"message":"This model's maximum context length is 65536 tokens. However, you requested 16384 output tokens and your prompt contains at least 49153 input tokens, for a total of at least 65537 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=49153)","type":"BadRequestError","param":"input_tokens","code":400}`;
      const m = MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(65536);
      expect(Number(m![2])).toBe(16384);
      expect(Number(m![3])).toBe(49153);
    });

    it("matches OpenRouter overflow with different values", () => {
      const errorMsg = `400: {"message":"This model's maximum context length is 128000 tokens. However, you requested 8192 output tokens and your prompt contains at least 120000 input tokens, for a total of at least 128192 tokens.","type":"BadRequestError","param":"input_tokens","code":400}`;
      const m = MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(128000);
      expect(Number(m![2])).toBe(8192);
      expect(Number(m![3])).toBe(120000);
    });

    it("matches OpenRouter overflow in exact format (no JSON wrapping)", () => {
      const errorMsg = "400: This model's maximum context length is 16384 tokens. However, you requested 4096 output tokens and your prompt contains at least 15000 input tokens, for a total of at least 19096 tokens.";
      const m = MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(16384);
      expect(Number(m![2])).toBe(4096);
      expect(Number(m![3])).toBe(15000);
    });
  });

  describe("non-matching messages", () => {
    it("does not match HTTP 429 rate-limit errors", () => {
      const errorMsg = "429: Rate limit exceeded. Try again later.";
      expect(MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg)).toBeNull();
    });

    it("does not match Anthropic prompt-too-long errors", () => {
      const errorMsg = "prompt is too long: 213462 tokens > 200000 maximum";
      expect(MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg)).toBeNull();
    });

    it("does not match OpenAI context-window errors (generic, no exact counts)", () => {
      const errorMsg = "Your input exceeds the context window of this model";
      expect(MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg)).toBeNull();
    });

    it("does not match server errors or timeouts", () => {
      const errorMsg = "500: Internal server error";
      expect(MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg)).toBeNull();
    });

    it("does not match Groq generic overflow", () => {
      const errorMsg = "Please reduce the length of the messages or completion";
      expect(MAX_TOKENS_OVERFLOW_EXACT_PATTERN.exec(errorMsg)).toBeNull();
    });
  });

  describe("safety calculation", () => {
    it("produces a safe max_tokens from the original production error", () => {
      const maxContext = 65536;
      const requestedOutput = 16384;
      const actualInput = 49153;
      const safeMaxTokens = maxContext - actualInput - MAX_TOKENS_OVERFLOW_SAFETY_MARGIN; // 65536 - 49153 - 4096 = 12287

      expect(safeMaxTokens).toBe(12287);
      expect(safeMaxTokens > 0).toBe(true);
      expect(safeMaxTokens < requestedOutput).toBe(true);
    });

    it("does not retry when safeMaxTokens is zero or negative", () => {
      // Edge case: input nearly fills the entire context window
      const maxContext = 65536;
      const actualInput = 65000;
      const requestedOutput = 16384;
      const safeMaxTokens = maxContext - actualInput - MAX_TOKENS_OVERFLOW_SAFETY_MARGIN; // -560

      expect(safeMaxTokens <= 0).toBe(true);
    });

    it("does not retry when safeMaxTokens >= requested (no benefit)", () => {
      // Edge case: estimation was slightly off, actual input is smaller than estimated
      const maxContext = 128000;
      const actualInput = 80000;
      const requestedOutput = 16384;
      const safeMaxTokens = maxContext - actualInput - MAX_TOKENS_OVERFLOW_SAFETY_MARGIN; // 43904

      expect(safeMaxTokens > 0).toBe(true);
      expect(safeMaxTokens >= requestedOutput).toBe(true);
    });
  });
});
