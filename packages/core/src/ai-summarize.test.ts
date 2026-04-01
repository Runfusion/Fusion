import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  summarizeTitle,
  checkRateLimit,
  getRateLimitResetTime,
  validateDescription,
  SUMMARIZE_SYSTEM_PROMPT,
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_REQUESTS_PER_HOUR,
  ValidationError,
  RateLimitError,
  AiServiceError,
  __resetSummarizeState,
} from "./ai-summarize.js";

describe("ai-summarize", () => {
  beforeEach(() => {
    __resetSummarizeState();
  });

  // ── Constants ──────────────────────────────────────────────────────────────

  describe("constants", () => {
    it("should have correct system prompt", () => {
      expect(SUMMARIZE_SYSTEM_PROMPT).toContain("max 60 characters");
      expect(SUMMARIZE_SYSTEM_PROMPT).toContain("title summarization");
    });

    it("should have correct length limits", () => {
      expect(MIN_DESCRIPTION_LENGTH).toBe(141);
      expect(MAX_DESCRIPTION_LENGTH).toBe(2000);
      expect(MAX_TITLE_LENGTH).toBe(60);
    });

    it("should have correct rate limit", () => {
      expect(MAX_REQUESTS_PER_HOUR).toBe(10);
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe("validateDescription", () => {
    it("should accept valid description length", () => {
      const desc = "a".repeat(200);
      expect(validateDescription(desc)).toBe(desc);
    });

    it("should throw for null description", () => {
      expect(() => validateDescription(null)).toThrow(ValidationError);
      expect(() => validateDescription(null)).toThrow("description is required");
    });

    it("should throw for undefined description", () => {
      expect(() => validateDescription(undefined)).toThrow(ValidationError);
    });

    it("should throw for non-string description", () => {
      expect(() => validateDescription(123)).toThrow(ValidationError);
      expect(() => validateDescription(123)).toThrow("description must be a string");
    });

    it("should throw for description too short", () => {
      const desc = "a".repeat(100);
      expect(() => validateDescription(desc)).toThrow(ValidationError);
      expect(() => validateDescription(desc)).toThrow("at least 141 characters");
    });

    it("should throw for description too long", () => {
      const desc = "a".repeat(2001);
      expect(() => validateDescription(desc)).toThrow(ValidationError);
      expect(() => validateDescription(desc)).toThrow("not exceed 2000 characters");
    });

    it("should accept description at minimum boundary", () => {
      const desc = "a".repeat(141);
      expect(validateDescription(desc)).toBe(desc);
    });

    it("should accept description at maximum boundary", () => {
      const desc = "a".repeat(2000);
      expect(validateDescription(desc)).toBe(desc);
    });
  });

  // ── Rate Limiting ──────────────────────────────────────────────────────────

  describe("checkRateLimit", () => {
    it("should allow first request from IP", () => {
      expect(checkRateLimit("192.168.1.1")).toBe(true);
    });

    it("should track request count", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }
      expect(checkRateLimit(ip)).toBe(true); // 6th request
    });

    it("should block after max requests", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }
      expect(checkRateLimit(ip)).toBe(false); // 11th request should be blocked
    });

    it("should track different IPs separately", () => {
      const ip1 = "192.168.1.1";
      const ip2 = "192.168.1.2";

      for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
        expect(checkRateLimit(ip1)).toBe(true);
      }
      expect(checkRateLimit(ip1)).toBe(false);

      // Different IP should still be allowed
      expect(checkRateLimit(ip2)).toBe(true);
    });
  });

  describe("getRateLimitResetTime", () => {
    it("should return null for unknown IP", () => {
      expect(getRateLimitResetTime("unknown")).toBeNull();
    });

    it("should return reset time after requests", () => {
      const ip = "192.168.1.1";
      checkRateLimit(ip);

      const resetTime = getRateLimitResetTime(ip);
      expect(resetTime).toBeInstanceOf(Date);
      expect(resetTime!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ── summarizeTitle ─────────────────────────────────────────────────────────

  describe("summarizeTitle", () => {
    it("should return null for descriptions <= 140 characters", async () => {
      const result = await summarizeTitle("Short description", "/tmp");
      expect(result).toBeNull();
    });

    it("should throw AiServiceError when engine not available", async () => {
      // In test environment, the dynamic import fails, so createKbAgent is undefined
      const longDesc = "a".repeat(200);
      await expect(summarizeTitle(longDesc, "/tmp")).rejects.toThrow(AiServiceError);
      await expect(summarizeTitle(longDesc, "/tmp")).rejects.toThrow("AI engine not available");
    });

    it("should accept optional provider and modelId", async () => {
      // Since engine isn't available in tests, this will throw
      const longDesc = "a".repeat(200);
      await expect(
        summarizeTitle(longDesc, "/tmp", "anthropic", "claude-sonnet-4-5")
      ).rejects.toThrow(AiServiceError);
    });
  });

  // ── Error Classes ───────────────────────────────────────────────────────────

  describe("error classes", () => {
    it("ValidationError should have correct name", () => {
      const err = new ValidationError("test");
      expect(err.name).toBe("ValidationError");
      expect(err.message).toBe("test");
    });

    it("RateLimitError should have correct name and resetTime", () => {
      const resetTime = new Date();
      const err = new RateLimitError("rate limited", resetTime);
      expect(err.name).toBe("RateLimitError");
      expect(err.message).toBe("rate limited");
      expect(err.resetTime).toBe(resetTime);
    });

    it("RateLimitError should allow null resetTime", () => {
      const err = new RateLimitError("rate limited");
      expect(err.name).toBe("RateLimitError");
      expect(err.resetTime).toBeNull();
    });

    it("AiServiceError should have correct name", () => {
      const err = new AiServiceError("ai failed");
      expect(err.name).toBe("AiServiceError");
      expect(err.message).toBe("ai failed");
    });
  });

  // ── State Reset ───────────────────────────────────────────────────────────

  describe("__resetSummarizeState", () => {
    it("should clear all rate limit entries", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < 5; i++) {
        checkRateLimit(ip);
      }

      expect(getRateLimitResetTime(ip)).not.toBeNull();

      __resetSummarizeState();

      expect(getRateLimitResetTime(ip)).toBeNull();
    });
  });
});
