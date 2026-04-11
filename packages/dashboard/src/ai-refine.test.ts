import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  refineText,
  validateRefineRequest,
  checkRateLimit,
  getRateLimitResetTime,
  __resetRefineState,
  ValidationError,
  InvalidTypeError,
  AiServiceError,
  VALID_REFINEMENT_TYPES,
  MIN_TEXT_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_REQUESTS_PER_HOUR,
  RATE_LIMIT_WINDOW_MS,
} from "./ai-refine.js";

// Hoisted mock factory
const { mockCreateKbAgent } = vi.hoisted(() => ({
  mockCreateKbAgent: vi.fn(),
}));

// Mock the engine module to avoid dynamic import issues in tests
vi.mock("@fusion/engine", () => ({
  createKbAgent: mockCreateKbAgent,
}));

describe("ai-refine module", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetRefineState();
    vi.clearAllMocks();
    mockCreateKbAgent.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("VALID_REFINEMENT_TYPES", () => {
    it("contains all four refinement types", () => {
      expect(VALID_REFINEMENT_TYPES).toEqual([
        "clarify",
        "add-details",
        "expand",
        "simplify",
      ]);
    });
  });

  describe("validateRefineRequest", () => {
    it("accepts valid text and 'clarify' type", () => {
      const result = validateRefineRequest("Some text", "clarify");
      expect(result).toEqual({ text: "Some text", type: "clarify" });
    });

    it("accepts valid text and 'add-details' type", () => {
      const result = validateRefineRequest("Some text", "add-details");
      expect(result).toEqual({ text: "Some text", type: "add-details" });
    });

    it("accepts valid text and 'expand' type", () => {
      const result = validateRefineRequest("Some text", "expand");
      expect(result).toEqual({ text: "Some text", type: "expand" });
    });

    it("accepts valid text and 'simplify' type", () => {
      const result = validateRefineRequest("Some text", "simplify");
      expect(result).toEqual({ text: "Some text", type: "simplify" });
    });

    it("throws ValidationError for missing text", () => {
      expect(() => validateRefineRequest(undefined, "clarify")).toThrow(ValidationError);
      expect(() => validateRefineRequest(undefined, "clarify")).toThrow("text is required");
    });

    it("throws ValidationError for null text", () => {
      expect(() => validateRefineRequest(null, "clarify")).toThrow(ValidationError);
      expect(() => validateRefineRequest(null, "clarify")).toThrow("text is required");
    });

    it("throws ValidationError for non-string text", () => {
      expect(() => validateRefineRequest(123, "clarify")).toThrow(ValidationError);
      expect(() => validateRefineRequest(123, "clarify")).toThrow("text must be a string");
    });

    it("throws ValidationError for empty text", () => {
      expect(() => validateRefineRequest("", "clarify")).toThrow(ValidationError);
      expect(() => validateRefineRequest("", "clarify")).toThrow(
        `text must be at least ${MIN_TEXT_LENGTH} character`
      );
    });

    it("throws ValidationError for text exceeding MAX_TEXT_LENGTH", () => {
      const longText = "a".repeat(MAX_TEXT_LENGTH + 1);
      expect(() => validateRefineRequest(longText, "clarify")).toThrow(ValidationError);
      expect(() => validateRefineRequest(longText, "clarify")).toThrow(
        `text must not exceed ${MAX_TEXT_LENGTH} characters`
      );
    });

    it("accepts text at exactly MAX_TEXT_LENGTH", () => {
      const maxText = "a".repeat(MAX_TEXT_LENGTH);
      const result = validateRefineRequest(maxText, "clarify");
      expect(result.text).toHaveLength(MAX_TEXT_LENGTH);
    });

    it("accepts text at exactly MIN_TEXT_LENGTH", () => {
      const result = validateRefineRequest("a", "clarify");
      expect(result.text).toBe("a");
    });

    it("throws ValidationError for missing type", () => {
      expect(() => validateRefineRequest("some text", undefined)).toThrow(ValidationError);
      expect(() => validateRefineRequest("some text", undefined)).toThrow("type is required");
    });

    it("throws ValidationError for null type", () => {
      expect(() => validateRefineRequest("some text", null)).toThrow(ValidationError);
      expect(() => validateRefineRequest("some text", null)).toThrow("type is required");
    });

    it("throws InvalidTypeError for invalid type string", () => {
      expect(() => validateRefineRequest("some text", "invalid")).toThrow(InvalidTypeError);
      expect(() => validateRefineRequest("some text", "invalid")).toThrow(
        "type must be one of: clarify, add-details, expand, simplify"
      );
    });

    it("throws InvalidTypeError for numeric type", () => {
      expect(() => validateRefineRequest("some text", 123)).toThrow(InvalidTypeError);
    });
  });

  describe("checkRateLimit", () => {
    it("allows first request from an IP", () => {
      expect(checkRateLimit("192.168.1.1")).toBe(true);
    });

    it("allows up to MAX_REQUESTS_PER_HOUR requests", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }
    });

    it("blocks request beyond MAX_REQUESTS_PER_HOUR", () => {
      const ip = "192.168.1.1";
      // Use up the quota
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
        checkRateLimit(ip);
      }
      // 11th request should be blocked
      expect(checkRateLimit(ip)).toBe(false);
    });

    it("tracks different IPs independently", () => {
      const ip1 = "192.168.1.1";
      const ip2 = "192.168.1.2";

      // Use up quota for ip1
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
        checkRateLimit(ip1);
      }
      expect(checkRateLimit(ip1)).toBe(false);

      // ip2 should still have full quota
      expect(checkRateLimit(ip2)).toBe(true);
    });

    it("resets rate limit after RATE_LIMIT_WINDOW_MS", () => {
      const ip = "192.168.1.1";

      // Use up the quota
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) {
        checkRateLimit(ip);
      }
      expect(checkRateLimit(ip)).toBe(false);

      // Advance time by 1 hour + 1ms
      vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1);

      // Should be allowed again
      expect(checkRateLimit(ip)).toBe(true);
    });

    it("resets count but tracks new window after expiry", () => {
      const ip = "192.168.1.1";

      // Make 5 requests
      for (let i = 0; i < 5; i++) {
        checkRateLimit(ip);
      }

      // Advance time by 1 hour + 1ms
      vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1);

      // First request in new window should work
      expect(checkRateLimit(ip)).toBe(true);

      // Use up remaining quota in new window
      for (let i = 0; i < MAX_REQUESTS_PER_HOUR - 1; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }

      // Next request should be blocked
      expect(checkRateLimit(ip)).toBe(false);
    });
  });

  describe("getRateLimitResetTime", () => {
    it("returns null for unknown IP", () => {
      expect(getRateLimitResetTime("unknown-ip")).toBeNull();
    });

    it("returns reset time after a request is made", () => {
      const ip = "192.168.1.1";
      const beforeRequest = Date.now();

      checkRateLimit(ip);

      const resetTime = getRateLimitResetTime(ip);
      expect(resetTime).not.toBeNull();
      expect(resetTime!.getTime()).toBe(beforeRequest + RATE_LIMIT_WINDOW_MS);
    });

    it("returns updated reset time after window resets", () => {
      const ip = "192.168.1.1";

      checkRateLimit(ip);
      const firstResetTime = getRateLimitResetTime(ip);

      // Advance time past the window
      vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1000);

      // Make another request
      checkRateLimit(ip);
      const secondResetTime = getRateLimitResetTime(ip);

      // Second reset time should be later than first
      expect(secondResetTime!.getTime()).toBeGreaterThan(firstResetTime!.getTime());
    });
  });

  describe("error classes", () => {
    it("ValidationError has correct name", () => {
      const error = new ValidationError("test");
      expect(error.name).toBe("ValidationError");
      expect(error.message).toBe("test");
    });

    it("InvalidTypeError has correct name", () => {
      const error = new InvalidTypeError("test");
      expect(error.name).toBe("InvalidTypeError");
      expect(error.message).toBe("test");
    });

    it("AiServiceError has correct name", () => {
      const error = new AiServiceError("test");
      expect(error.name).toBe("AiServiceError");
      expect(error.message).toBe("test");
    });
  });

  describe("refineText", () => {
    // Note: refineText requires the AI engine which is not available in tests.
    // These tests verify error handling when the engine is unavailable.

    it("throws AiServiceError when AI engine is not available", async () => {
      await expect(refineText("some text", "clarify", "/some/path")).rejects.toThrow(
        AiServiceError
      );
      await expect(refineText("some text", "clarify", "/some/path")).rejects.toThrow(
        "Failed to initialize AI agent"
      );
    });
  });

  describe("__resetRefineState", () => {
    it("clears all rate limit entries", () => {
      const ip = "192.168.1.1";

      // Make requests to populate rate limits
      for (let i = 0; i < 5; i++) {
        checkRateLimit(ip);
      }
      expect(getRateLimitResetTime(ip)).not.toBeNull();

      // Reset state
      __resetRefineState();

      // Should be like starting fresh
      expect(getRateLimitResetTime(ip)).toBeNull();
      expect(checkRateLimit(ip)).toBe(true);
    });
  });

  describe("prompt override regression", () => {
    const customPrompt = "You are a custom refine assistant.";

    function createRefineMockAgent(responseText: string) {
      return {
        session: {
          state: {
            messages: [
              { role: "assistant", content: responseText },
            ],
          },
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      };
    }

    it("uses default prompt when no overrides provided", async () => {
      const mockAgent = createRefineMockAgent("Refined text here");
      mockCreateKbAgent.mockResolvedValueOnce(mockAgent);

      await refineText("some text", "clarify", "/tmp/project");

      expect(mockCreateKbAgent).toHaveBeenCalled();
      const call = mockCreateKbAgent.mock.calls[0];
      expect(call[0].systemPrompt).toMatch(/^You are a text refinement assistant/);
    });

    it("uses override prompt when promptOverrides provided", async () => {
      const mockAgent = createRefineMockAgent("Refined text here");
      mockCreateKbAgent.mockResolvedValueOnce(mockAgent);

      await refineText("some text", "clarify", "/tmp/project", {
        "ai-refine-system": customPrompt,
      });

      expect(mockCreateKbAgent).toHaveBeenCalled();
      const call = mockCreateKbAgent.mock.calls[0];
      expect(call[0].systemPrompt).toBe(customPrompt);
    });

    it("falls back to default prompt when override is empty string", async () => {
      const mockAgent = createRefineMockAgent("Refined text here");
      mockCreateKbAgent.mockResolvedValueOnce(mockAgent);

      await refineText("some text", "simplify", "/tmp/project", {
        "ai-refine-system": "",
      });

      expect(mockCreateKbAgent).toHaveBeenCalled();
      const call = mockCreateKbAgent.mock.calls[0];
      expect(call[0].systemPrompt).toMatch(/^You are a text refinement assistant/);
    });

    it("does not introduce unexpected model/provider override fields in createKbAgent", async () => {
      const mockAgent = createRefineMockAgent("Refined text here");
      mockCreateKbAgent.mockResolvedValueOnce(mockAgent);

      await refineText("some text", "expand", "/tmp/project", {
        "ai-refine-system": customPrompt,
      });

      expect(mockCreateKbAgent).toHaveBeenCalled();
      const call = mockCreateKbAgent.mock.calls[0];
      const agentConfig = call[0];

      // Verify only expected fields are present
      expect(agentConfig).toHaveProperty("cwd");
      expect(agentConfig).toHaveProperty("systemPrompt");
      expect(agentConfig).toHaveProperty("tools");

      // Verify no unexpected model override fields
      expect(agentConfig).not.toHaveProperty("modelProvider");
      expect(agentConfig).not.toHaveProperty("modelId");
      expect(agentConfig).not.toHaveProperty("provider");
      expect(agentConfig).not.toHaveProperty("model");
    });

    it("prompt overrides do not affect other prompt keys", async () => {
      const mockAgent = createRefineMockAgent("Refined text here");
      mockCreateKbAgent.mockResolvedValueOnce(mockAgent);

      // Provide overrides for a different key only
      await refineText("some text", "clarify", "/tmp/project", {
        "workflow-step-refine": "Should not affect AI refine",
      });

      expect(mockCreateKbAgent).toHaveBeenCalled();
      const call = mockCreateKbAgent.mock.calls[0];
      // AI refine should use its own default prompt, not affected by workflow-step-refine override
      expect(call[0].systemPrompt).toMatch(/^You are a text refinement assistant/);
    });
  });
});
