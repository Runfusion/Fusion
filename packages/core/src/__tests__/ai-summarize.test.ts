import { describe, it, expect, beforeEach, vi } from "vitest";

const { getFnAgentMock } = vi.hoisted(() => ({
  getFnAgentMock: vi.fn(),
}));

vi.mock("../ai-engine-loader.js", () => ({
  getFnAgent: getFnAgentMock,
}));

import {
  summarizeTitle,
  summarizeMergeCommit,
  summarizeCommitBody,
  sanitizeCommitSubject,
  MAX_COMMIT_SUBJECT_LENGTH,
  checkRateLimit,
  getRateLimitResetTime,
  validateDescription,
  SUMMARIZE_SYSTEM_PROMPT,
  MERGE_COMMIT_SUMMARIZE_SYSTEM_PROMPT,
  COMMIT_BODY_SYSTEM_PROMPT,
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_MERGE_COMMIT_SUMMARY_LENGTH,
  MAX_COMMIT_BODY_INPUT_LENGTH,
  MAX_COMMIT_BODY_LENGTH,
  DEFAULT_COMMIT_BODY_TIMEOUT_MS,
  MAX_REQUESTS_PER_HOUR,
  ValidationError,
  RateLimitError,
  AiServiceError,
  __resetSummarizeState,
} from "../ai-summarize.js";

describe("ai-summarize", () => {
  beforeEach(() => {
    __resetSummarizeState();
    getFnAgentMock.mockReset();
    getFnAgentMock.mockResolvedValue(null);
  });

  // ── Constants ──────────────────────────────────────────────────────────────

  describe("constants", () => {
    it("should have correct system prompt", () => {
      expect(SUMMARIZE_SYSTEM_PROMPT).toContain("max 60 characters");
      expect(SUMMARIZE_SYSTEM_PROMPT).toContain("title summarization");
    });

    it("should have correct length limits", () => {
      expect(MIN_DESCRIPTION_LENGTH).toBe(201);
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
      const desc = "a".repeat(201);
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
      expect(() => validateDescription(desc)).toThrow("at least 201 characters");
    });

    it("should throw for description too long", () => {
      const desc = "a".repeat(2001);
      expect(() => validateDescription(desc)).toThrow(ValidationError);
      expect(() => validateDescription(desc)).toThrow("not exceed 2000 characters");
    });

    it("should accept description at minimum boundary", () => {
      const desc = "a".repeat(201);
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
    it("should return null for descriptions <= 200 characters", async () => {
      const result = await summarizeTitle("Short description", "/tmp");
      expect(result).toBeNull();
    });

    it("should throw AiServiceError when AI service cannot process request", async () => {
      const longDesc = "a".repeat(201);

      await expect(summarizeTitle(longDesc, "/tmp")).rejects.toThrow(AiServiceError);
      await expect(summarizeTitle(longDesc, "/tmp")).rejects.toThrow(
        /(AI engine not available|No model selected)/
      );
    });

    it("should accept optional provider and modelId", async () => {
      // Since engine isn't available in tests, this will throw
      const longDesc = "a".repeat(201);
      await expect(
        summarizeTitle(longDesc, "/tmp", "anthropic", "claude-sonnet-4-5")
      ).rejects.toThrow(AiServiceError);
    });
  });

  describe("summarizeMergeCommit", () => {
    it("returns null when commit log and diff stat are empty", async () => {
      expect(await summarizeMergeCommit("", "", "/tmp")).toBeNull();
      expect(await summarizeMergeCommit("   ", "\n\n", "/tmp")).toBeNull();
    });

    it("returns summary text when AI responds", async () => {
      const prompt = vi.fn().mockResolvedValue(undefined);
      getFnAgentMock.mockResolvedValue(() =>
        Promise.resolve({
          session: {
            prompt,
            dispose: vi.fn(),
            state: {
              messages: [
                {
                  role: "assistant",
                  content: "Updated merger and settings wiring for AI commit summaries.",
                },
              ],
            },
          },
        })
      );

      const summary = await summarizeMergeCommit(
        "- feat: add summary\n- test: add coverage",
        "merger.ts | 20 ++++++++++-----",
        "/tmp"
      );

      expect(summary).toBe("Updated merger and settings wiring for AI commit summaries.");
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("throws AiServiceError when AI engine is unavailable", async () => {
      await expect(
        summarizeMergeCommit("- feat: add summary", "merger.ts | 2 ++", "/tmp")
      ).rejects.toThrow(AiServiceError);
      await expect(
        summarizeMergeCommit("- feat: add summary", "merger.ts | 2 ++", "/tmp")
      ).rejects.toThrow("AI engine not available");
    });

    it("exposes merge summary constants", () => {
      expect(MERGE_COMMIT_SUMMARIZE_SYSTEM_PROMPT).toContain("1-3 concise sentences");
      expect(MAX_MERGE_COMMIT_SUMMARY_LENGTH).toBe(300);
    });
  });

  describe("summarizeCommitBody", () => {
    it("returns null for empty diff stat (nothing to summarize)", async () => {
      expect(await summarizeCommitBody("", "/tmp")).toBeNull();
      expect(await summarizeCommitBody("   \n  ", "/tmp")).toBeNull();
    });

    it("returns null when AI engine is unavailable (graceful, never throws)", async () => {
      const result = await summarizeCommitBody(
        "src/foo.ts | 5 +++--\n1 file changed",
        "/tmp",
      );
      expect(result).toBeNull();
    });

    it("returns null when AI engine is unavailable even with model selection", async () => {
      // Should NOT throw — the contract is fail-soft so the merger can fall
      // back to its deterministic body cascade without losing the merge.
      const result = await summarizeCommitBody(
        "src/foo.ts | 5 +++--\n1 file changed",
        "/tmp",
        "anthropic",
        "claude-sonnet-4-5",
      );
      expect(result).toBeNull();
    });

    it("returns null when caller's abort signal is already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      const result = await summarizeCommitBody(
        "src/foo.ts | 5 +++--\n1 file changed",
        "/tmp",
        undefined,
        undefined,
        { signal: ac.signal },
      );
      expect(result).toBeNull();
    });

    it("respects custom timeout (returns null on timeout, never hangs)", async () => {
      // Timeout is 1ms — faster than any real AI call, and the helper aborts
      // the in-flight session and returns null instead of hanging the merge.
      const start = Date.now();
      const result = await summarizeCommitBody(
        "src/foo.ts | 5 +++--\n1 file changed",
        "/tmp",
        undefined,
        undefined,
        { timeoutMs: 1 },
      );
      const elapsed = Date.now() - start;
      expect(result).toBeNull();
      // Belt-and-braces: even if the engine isn't available the call should
      // return very quickly. The 1s ceiling guards against future regressions
      // that might accidentally block.
      expect(elapsed).toBeLessThan(1000);
    });

    it("exposes sensible constants", () => {
      expect(COMMIT_BODY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
      expect(COMMIT_BODY_SYSTEM_PROMPT).toContain("commit message");
      expect(MAX_COMMIT_BODY_INPUT_LENGTH).toBeGreaterThan(1000);
      expect(MAX_COMMIT_BODY_LENGTH).toBeGreaterThan(100);
      expect(DEFAULT_COMMIT_BODY_TIMEOUT_MS).toBeGreaterThan(0);
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

  describe("sanitizeCommitSubject", () => {
    it("returns null for empty / whitespace input", () => {
      expect(sanitizeCommitSubject("")).toBeNull();
      expect(sanitizeCommitSubject("   \n  ")).toBeNull();
    });

    it("keeps a clean subject as-is", () => {
      expect(sanitizeCommitSubject("add unavailable-node validation")).toBe(
        "add unavailable-node validation",
      );
    });

    it("uses only the first non-empty line", () => {
      expect(sanitizeCommitSubject("add validation\n\nbody text here")).toBe(
        "add validation",
      );
      expect(sanitizeCommitSubject("\n\n  refactor merger\nignored second line")).toBe(
        "refactor merger",
      );
    });

    it("strips surrounding quotes and backticks", () => {
      expect(sanitizeCommitSubject('"add tests for store"')).toBe("add tests for store");
      expect(sanitizeCommitSubject("'fix race in heartbeat'")).toBe("fix race in heartbeat");
      expect(sanitizeCommitSubject("`add caching layer`")).toBe("add caching layer");
    });

    it("strips a leading bullet marker", () => {
      expect(sanitizeCommitSubject("- add caching layer")).toBe("add caching layer");
      expect(sanitizeCommitSubject("* fix bug")).toBe("fix bug");
    });

    it("drops a leading conventional-commit prefix the model adds back", () => {
      expect(sanitizeCommitSubject("feat: add validation")).toBe("add validation");
      expect(sanitizeCommitSubject("feat(FN-123): add validation")).toBe("add validation");
      expect(sanitizeCommitSubject("fix(scope): something")).toBe("something");
      expect(sanitizeCommitSubject("FEAT: shouty")).toBe("shouty");
    });

    it("drops a trailing period", () => {
      expect(sanitizeCommitSubject("add validation.")).toBe("add validation");
      expect(sanitizeCommitSubject("add validation...")).toBe("add validation");
    });

    it("hard-caps at MAX_COMMIT_SUBJECT_LENGTH", () => {
      const long = "a".repeat(MAX_COMMIT_SUBJECT_LENGTH + 20);
      const result = sanitizeCommitSubject(long);
      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(MAX_COMMIT_SUBJECT_LENGTH);
    });

    it("returns null when stripping leaves nothing", () => {
      expect(sanitizeCommitSubject('""')).toBeNull();
      expect(sanitizeCommitSubject("feat:   ")).toBeNull();
    });
  });

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
