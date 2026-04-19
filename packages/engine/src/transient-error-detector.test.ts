import { describe, it, expect } from "vitest";
import {
  isTransientError,
  classifyError,
  isSilentTransientError,
  TRANSIENT_ERROR_PATTERNS,
} from "./transient-error-detector.js";
import { isUsageLimitError } from "./usage-limit-detector.js";

describe("Transient Error Detector", () => {
  describe("isTransientError", () => {
    // Core error messages from the task description
    it("matches the full upstream connect error message", () => {
      const message =
        "upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused";
      expect(isTransientError(message)).toBe(true);
    });

    it("matches 'upstream connect error'", () => {
      expect(isTransientError("upstream connect error")).toBe(true);
      expect(isTransientError("Upstream Connect Error")).toBe(true);
      expect(isTransientError("UPSTREAM CONNECT ERROR")).toBe(true);
    });

    it("matches 'disconnect/reset before headers'", () => {
      expect(isTransientError("disconnect/reset before headers")).toBe(true);
      expect(isTransientError("Disconnect/Reset Before Headers")).toBe(true);
    });

    it("matches 'retried and the latest reset reason'", () => {
      expect(isTransientError("retried and the latest reset reason: timeout")).toBe(true);
      expect(isTransientError("Retried And The Latest Reset Reason")).toBe(true);
    });

    it("matches 'remote connection failure'", () => {
      expect(isTransientError("remote connection failure")).toBe(true);
      expect(isTransientError("Remote Connection Failure")).toBe(true);
    });

    it("matches 'transport failure reason'", () => {
      expect(isTransientError("transport failure reason: connection reset")).toBe(true);
      expect(isTransientError("Transport Failure Reason")).toBe(true);
    });

    it("matches 'delayed connect error'", () => {
      expect(isTransientError("delayed connect error: Connection refused")).toBe(true);
      expect(isTransientError("Delayed Connect Error")).toBe(true);
    });

    it("matches 'Connection refused'", () => {
      expect(isTransientError("Connection refused")).toBe(true);
      expect(isTransientError("connection refused")).toBe(true);
      expect(isTransientError("CONNECTION REFUSED")).toBe(true);
    });

    it("matches 'connection reset'", () => {
      expect(isTransientError("connection reset by peer")).toBe(true);
      expect(isTransientError("Connection Reset")).toBe(true);
    });

    it("matches 'ECONNREFUSED'", () => {
      expect(isTransientError("ECONNREFUSED")).toBe(true);
      expect(isTransientError("Error: ECONNREFUSED")).toBe(true);
    });

    it("matches 'ETIMEDOUT'", () => {
      expect(isTransientError("ETIMEDOUT")).toBe(true);
      expect(isTransientError("Error: ETIMEDOUT")).toBe(true);
    });

    it("matches 'socket hang up'", () => {
      expect(isTransientError("socket hang up")).toBe(true);
      expect(isTransientError("Socket Hang Up")).toBe(true);
      expect(isTransientError("Error: socket hang up")).toBe(true);
    });

    it("matches connection timeout patterns", () => {
      expect(isTransientError("connection timeout")).toBe(true);
      expect(isTransientError("timeout connection to server")).toBe(true);
    });

    it("matches 'request was aborted' (AI provider abort errors)", () => {
      expect(isTransientError("request was aborted")).toBe(true);
      expect(isTransientError("Request was aborted")).toBe(true);
      expect(isTransientError("REQUEST WAS ABORTED")).toBe(true);
      expect(isTransientError("Error: request was aborted")).toBe(true);
    });

    it("matches 'operation was aborted' (DOMException-style abort errors)", () => {
      expect(isTransientError("operation was aborted")).toBe(true);
      expect(isTransientError("This operation was aborted")).toBe(true);
      expect(isTransientError("OPERATION WAS ABORTED")).toBe(true);
    });

    it("does NOT match user-initiated 'operation was aborted by user'", () => {
      expect(isTransientError("The operation was aborted by user")).toBe(false);
      expect(isTransientError("operation was aborted by the signal")).toBe(false);
    });

    // Edge cases
    it("returns false for empty string", () => {
      expect(isTransientError("")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isTransientError(null as unknown as string)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isTransientError(undefined as unknown as string)).toBe(false);
    });

    it("returns false for non-string values", () => {
      expect(isTransientError(123 as unknown as string)).toBe(false);
      expect(isTransientError({} as unknown as string)).toBe(false);
      expect(isTransientError([] as unknown as string)).toBe(false);
    });

    // Should NOT match non-transient errors
    it("returns false for code errors", () => {
      expect(isTransientError("SyntaxError: Unexpected token")).toBe(false);
      expect(isTransientError("TypeError: Cannot read property")).toBe(false);
      expect(isTransientError("ReferenceError: foo is not defined")).toBe(false);
    });

    it("returns false for test failures", () => {
      expect(isTransientError("Assertion failed: expected 1 to be 2")).toBe(false);
      expect(isTransientError("Test timeout of 5000ms exceeded")).toBe(false);
    });

    it("returns false for usage limit errors", () => {
      expect(isTransientError("rate limit exceeded")).toBe(false);
      expect(isTransientError("429 Too Many Requests")).toBe(false);
      expect(isTransientError("API quota exceeded")).toBe(false);
    });

    // Partial matches should not trigger false positives
    it("handles partial matches correctly", () => {
      // Should not match just "error" or "timeout" without connection context
      expect(isTransientError("An error occurred")).toBe(false);
      // "timeout" alone is not in the patterns (only connection timeouts)
      expect(isTransientError("timeout")).toBe(false);
      expect(isTransientError("Request timeout")).toBe(false);
      // "abort" alone should not match — only "request was aborted" is transient
      expect(isTransientError("abort")).toBe(false);
      expect(isTransientError("Aborted")).toBe(false);
      expect(isTransientError("The operation was aborted by user")).toBe(false);
    });
  });

  describe("classifyError", () => {
    it("classifies usage limit errors as 'usage-limit'", () => {
      expect(classifyError("rate limit exceeded")).toBe("usage-limit");
      expect(classifyError("429 Too Many Requests")).toBe("usage-limit");
      expect(classifyError("API overloaded")).toBe("usage-limit");
      expect(classifyError("quota exceeded")).toBe("usage-limit");
      expect(classifyError("billing issue")).toBe("usage-limit");
    });

    it("classifies transient errors as 'transient'", () => {
      expect(classifyError("upstream connect error")).toBe("transient");
      expect(classifyError("ECONNREFUSED")).toBe("transient");
      expect(classifyError("socket hang up")).toBe("transient");
      expect(classifyError("Connection refused")).toBe("transient");
      expect(classifyError("request was aborted")).toBe("transient");
    });

    it("classifies 'Request was aborted' as 'transient', not 'usage-limit'", () => {
      // Ensure abort errors are classified as transient, not usage-limit
      expect(classifyError("Request was aborted")).toBe("transient");
      expect(classifyError("REQUEST WAS ABORTED")).toBe("transient");
    });

    it("classifies all other errors as 'permanent'", () => {
      expect(classifyError("SyntaxError: Unexpected token")).toBe("permanent");
      expect(classifyError("Test failed")).toBe("permanent");
      expect(classifyError("Build error")).toBe("permanent");
    });

    // Priority: usage limit > transient > permanent
    it("prioritizes usage limits over transient errors", () => {
      // Usage limit patterns should take precedence
      const usageLimitMsg = "rate limit exceeded while connecting";
      expect(isUsageLimitError(usageLimitMsg)).toBe(true);
      expect(classifyError(usageLimitMsg)).toBe("usage-limit");
    });

    it("handles empty/invalid input as 'permanent'", () => {
      expect(classifyError("")).toBe("permanent");
      expect(classifyError(null as unknown as string)).toBe("permanent");
      expect(classifyError(undefined as unknown as string)).toBe("permanent");
    });

    it("classifies the full complex error message correctly", () => {
      const message =
        "upstream connect error or disconnect/reset before headers. retried and the latest reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused";
      expect(classifyError(message)).toBe("transient");
    });
  });

  describe("TRANSIENT_ERROR_PATTERNS", () => {
    it("exports the patterns array", () => {
      expect(Array.isArray(TRANSIENT_ERROR_PATTERNS)).toBe(true);
      expect(TRANSIENT_ERROR_PATTERNS.length).toBeGreaterThan(0);
      // All patterns should be RegExp
      TRANSIENT_ERROR_PATTERNS.forEach((pattern) => {
        expect(pattern).toBeInstanceOf(RegExp);
      });
    });

    it("all patterns have case-insensitive flag", () => {
      TRANSIENT_ERROR_PATTERNS.forEach((pattern) => {
        expect(pattern.flags).toContain("i");
      });
    });
  });

  describe("isSilentTransientError", () => {
    it("returns true for 'request was aborted'", () => {
      expect(isSilentTransientError("request was aborted")).toBe(true);
      expect(isSilentTransientError("Request was aborted")).toBe(true);
      expect(isSilentTransientError("REQUEST WAS ABORTED")).toBe(true);
      expect(isSilentTransientError("Error: request was aborted")).toBe(true);
    });

    it("returns false for other transient errors", () => {
      expect(isSilentTransientError("ECONNREFUSED")).toBe(false);
      expect(isSilentTransientError("socket hang up")).toBe(false);
      expect(isSilentTransientError("upstream connect error")).toBe(false);
      expect(isSilentTransientError("connection reset")).toBe(false);
    });

    it("returns false for non-transient errors", () => {
      expect(isSilentTransientError("SyntaxError: Unexpected token")).toBe(false);
      expect(isSilentTransientError("Test failed")).toBe(false);
    });

    it("returns false for empty/invalid input", () => {
      expect(isSilentTransientError("")).toBe(false);
      expect(isSilentTransientError(null as unknown as string)).toBe(false);
      expect(isSilentTransientError(undefined as unknown as string)).toBe(false);
    });

    it("returns false for partial matches like 'abort' alone", () => {
      expect(isSilentTransientError("abort")).toBe(false);
      expect(isSilentTransientError("Aborted")).toBe(false);
      expect(isSilentTransientError("The operation was aborted by user")).toBe(false);
    });
  });
});
