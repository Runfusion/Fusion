import { describe, it, expect } from "vitest";
import {
  isTransientError,
  isTransientAuthCredentialError,
  classifyError,
  isSilentTransientError,
  extractMissingModulePath,
  isOperatorActionableAgentError,
  isStaleWorktreeModuleResolutionError,
  isModelAuthTierIncompatibilityError,
  isProviderModelNotFoundError,
  isUnsupportedMessageRoleError,
  isNonContinuableSessionError,
  isNonPlanDefectPlanReviewFailure,
  TRANSIENT_ERROR_PATTERNS,
} from "../transient-error-detector.js";
import { isUsageLimitError } from "../usage-limit-detector.js";

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

    it("matches connection reset errno messages", () => {
      expect(isTransientError("ECONNRESET")).toBe(true);
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

    it("matches pi-ai Codex WebSocket transport drops", () => {
      // Bare "WebSocket error" — pi-ai falls back to this when the ErrorEvent
      // has no `message`. The diagnostic patch tags the model id onto it.
      expect(isTransientError("WebSocket error")).toBe(true);
      expect(isTransientError("WebSocket error (model=openai/gpt-5-codex)")).toBe(true);
      // "WebSocket closed <code> <reason>" from extractWebSocketCloseError.
      expect(isTransientError("WebSocket closed 1006")).toBe(true);
      expect(isTransientError("WebSocket closed 1011 internal error")).toBe(true);
      expect(isTransientError("WebSocket closed")).toBe(true);
      // Half-open stream that ended before response.completed.
      expect(isTransientError("WebSocket stream closed before response.completed")).toBe(true);
    });

    it("matches OpenAI/Codex structured server_error payloads", () => {
      const message = `Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 9349dabf-bcb7-4c36-aa40-f645dd04a472 in your message.","param":null},"sequence_number":2}`;
      expect(isTransientError(message)).toBe(true);
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

  describe("isNonPlanDefectPlanReviewFailure", () => {
    it.each([
      "429 Too Many Requests from the provider",
      "403 forbidden: model access is not enabled for this account",
      "Unable to select a usable model after 2 attempts (primary example/model)",
      "ECONNRESET while contacting reviewer",
      "WebSocket closed 1006",
      "request was aborted",
    ])("keeps provider failure in place: %s", (errorMessage) => {
      expect(isNonPlanDefectPlanReviewFailure({ errorMessage })).toBe(true);
    });

    it("keeps raw abort and exception failure values in place", () => {
      expect(isNonPlanDefectPlanReviewFailure({ failureValue: "exception" })).toBe(true);
      expect(isNonPlanDefectPlanReviewFailure({ failureValue: "aborted" })).toBe(true);
    });

    it("never classifies a genuine REVISE verdict as a provider failure", () => {
      expect(isNonPlanDefectPlanReviewFailure({
        verdict: "REVISE",
        errorMessage: "429 Too Many Requests",
        failureValue: "exception",
      })).toBe(false);
      expect(isNonPlanDefectPlanReviewFailure({ errorMessage: "PROMPT.md is missing acceptance criteria" })).toBe(false);
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

    it("classifies OpenAI/Codex server_error payloads as 'transient'", () => {
      const message = `Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 9349dabf-bcb7-4c36-aa40-f645dd04a472 in your message.","param":null},"sequence_number":2}`;
      expect(classifyError(message)).toBe("transient");
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

  describe("isStaleWorktreeModuleResolutionError", () => {
    it("returns true for cannot-find-module node_modules imported-from stale worktree signature", () => {
      const message =
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/me/Projects/kb/.worktrees/deleted/node_modules/@runfusion/fusion/dist/bin.js' imported from /Users/me/Projects/kb/.worktrees/deleted/packages/engine/src/pi.ts";
      expect(isStaleWorktreeModuleResolutionError(message)).toBe(true);
    });

    it("returns false for other missing-module errors without stale-path signature", () => {
      expect(isStaleWorktreeModuleResolutionError("Cannot find module 'vitest'")).toBe(false);
      expect(isStaleWorktreeModuleResolutionError("socket hang up")).toBe(false);
    });
  });

  describe("extractMissingModulePath", () => {
    it("extracts the missing node_modules path from stale signature", () => {
      const message =
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/me/Projects/kb/.worktrees/deleted/node_modules/@runfusion/fusion/dist/bin.js' imported from /Users/me/Projects/kb/.worktrees/deleted/packages/engine/src/pi.ts";
      expect(extractMissingModulePath(message)).toBe(
        "/Users/me/Projects/kb/.worktrees/deleted/node_modules/@runfusion/fusion/dist/bin.js",
      );
    });

    it("returns null when no stale module path is present", () => {
      expect(extractMissingModulePath("Cannot find module 'vitest'")).toBeNull();
      expect(extractMissingModulePath("socket hang up")).toBeNull();
    });
  });

  describe("isUnsupportedMessageRoleError", () => {
    it("returns true for the reported provider error", () => {
      expect(
        isUnsupportedMessageRoleError(
          "developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.[0].role'",
        ),
      ).toBe(true);
    });

    it("returns true for role/index/case variants", () => {
      expect(
        isUnsupportedMessageRoleError(
          "assistant_role is not one of ['system','assistant','user','tool','function'] - 'messages.[3].role'",
        ),
      ).toBe(true);
      expect(
        isUnsupportedMessageRoleError(
          "'MESSAGES.[9].ROLE' IS NOT ONE OF ['system','assistant']",
        ),
      ).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(isUnsupportedMessageRoleError("socket hang up")).toBe(false);
      expect(isUnsupportedMessageRoleError("invalid api key")).toBe(false);
    });
  });

  describe("isNonContinuableSessionError", () => {
    it("returns true for the reported assistant-role continuation error", () => {
      expect(isNonContinuableSessionError("Cannot continue from message role: assistant")).toBe(true);
    });

    it("returns true for quoted and role-variant forms", () => {
      expect(isNonContinuableSessionError("Cannot continue from message role 'assistant'"))
        .toBe(true);
      expect(isNonContinuableSessionError('Cannot continue from message role "assistant"'))
        .toBe(true);
      expect(isNonContinuableSessionError("cannot continue from message role=`tool`"))
        .toBe(true);
      expect(isNonContinuableSessionError("Cannot continue from message role user."))
        .toBe(true);
    });

    it("returns true for Codex transcript-desync errors", () => {
      expect(
        isNonContinuableSessionError(
          "No tool call found for function call output with call_id call_2KewW55MyBgwZoNtMubFNpUb.",
        ),
      ).toBe(true);
      expect(
        isNonContinuableSessionError(
          'Codex error: {"type":"error","error":{"type":"invalid_request_error","message":"No tool call found for function call output with call_id call_2KewW55MyBgwZoNtMubFNpUb.","param":"input"},"status":400}',
        ),
      ).toBe(true);
      expect(
        isNonContinuableSessionError(
          "No function call found for function call output with call_id call_2KewW55MyBgwZoNtMubFNpUb.",
        ),
      ).toBe(true);
    });

    it("returns false for unrelated, operator-actionable, and ordinary bad-input errors", () => {
      expect(isNonContinuableSessionError("socket hang up")).toBe(false);
      expect(
        isNonContinuableSessionError(
          "developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.[0].role'",
        ),
      ).toBe(false);
      expect(isNonContinuableSessionError("invalid api key")).toBe(false);
      expect(isNonContinuableSessionError("quota exceeded")).toBe(false);
      expect(isNonContinuableSessionError("billing issue: quota exceeded")).toBe(false);
      expect(isNonContinuableSessionError("400 invalid_request_error: invalid temperature")).toBe(false);
    });
  });

  describe("isModelAuthTierIncompatibilityError", () => {
    it("matches model compatibility errors without matching generic 400s", () => {
      expect(
        isModelAuthTierIncompatibilityError(
          "Codex error: 400 invalid_request_error — \"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"",
        ),
      ).toBe(true);
      expect(isModelAuthTierIncompatibilityError("model gpt-5.3-codex is not supported for this account")).toBe(true);
      expect(isModelAuthTierIncompatibilityError("400 invalid_request_error: model gpt-5.3-codex not found")).toBe(true);
      expect(isModelAuthTierIncompatibilityError("400 invalid_request_error: invalid temperature")).toBe(false);
    });
  });

  describe("isProviderModelNotFoundError", () => {
    it("matches provider-scoped model 404 payloads without matching generic 404s", () => {
      const anthropicSonnet5Error =
        'Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Not found"},"request_id":"req_011CcawcZ3Ra9CennJXM8oWC"}';

      expect(isProviderModelNotFoundError(anthropicSonnet5Error)).toBe(true);
      expect(isProviderModelNotFoundError("model claude-sonnet-5 not found")).toBe(true);
      expect(isProviderModelNotFoundError("model claude-sonnet-5 is not available on this account")).toBe(false);
      expect(isModelAuthTierIncompatibilityError("model claude-sonnet-5 is not available on this account")).toBe(true);
      expect(isProviderModelNotFoundError("GET /api/tasks/FN-404 returned 404 Not Found")).toBe(false);
      expect(isProviderModelNotFoundError("Task FN-404 not found")).toBe(false);
      expect(isProviderModelNotFoundError("404 Not Found: /api/chat/sessions/missing"))
        .toBe(false);
    });
  });

  describe("isOperatorActionableAgentError", () => {
    it("returns true for credential/model/billing errors", () => {
      expect(isOperatorActionableAgentError("invalid api key")).toBe(true);
      expect(isOperatorActionableAgentError("Authentication failed for provider")).toBe(true);
      expect(isOperatorActionableAgentError("model gpt-x not found")).toBe(true);
      expect(isOperatorActionableAgentError("missing OPENAI_API_KEY")).toBe(true);
      expect(isOperatorActionableAgentError("No API key for provider: anthropic")).toBe(true);
      expect(isOperatorActionableAgentError("billing issue: quota exceeded")).toBe(true);
      expect(isOperatorActionableAgentError("OAuth token does not meet scope requirements")).toBe(true);
      expect(isOperatorActionableAgentError("insufficient_scope: missing repo grant")).toBe(true);
      expect(
        isOperatorActionableAgentError(
          'Error: 404 {"type":"error","error":{"type":"not_found_error","message":"Not found"},"request_id":"req_011CcawcZ3Ra9CennJXM8oWC"}',
        ),
      ).toBe(true);
    });

    it("returns true for unsupported message-role errors", () => {
      const message =
        "developer is not one of ['system', 'assistant', 'user', 'tool', 'function'] - 'messages.[0].role'";
      expect(isOperatorActionableAgentError(message)).toBe(true);
      expect(classifyError(message)).toBe("permanent");
    });

    it("returns true for model-auth-tier compatibility errors", () => {
      expect(
        isOperatorActionableAgentError(
          "Codex error: 400 invalid_request_error — \"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"",
        ),
      ).toBe(true);
      expect(isOperatorActionableAgentError("model gpt-5.3-codex is not supported for this account")).toBe(true);
      expect(isOperatorActionableAgentError("400 invalid_request_error: missing required field messages")).toBe(false);
    });

    it("returns false for transient and generic retryable errors", () => {
      expect(isOperatorActionableAgentError("socket hang up")).toBe(false);
      expect(isOperatorActionableAgentError("upstream connect error")).toBe(false);
      expect(isOperatorActionableAgentError("Failed to start agent session: spawn ENOENT")).toBe(false);
      expect(isOperatorActionableAgentError("Unexpected end of JSON input")).toBe(false);
    });
  });

  /*
  FNXC:Reliability-ErrorClassification 2026-07-12-20:10:
  Regression suite for the durable-agent OAuth token-rotation incident: a routine Claude Max
  credential rotation surfaced as `401 {"type":"authentication_error","message":"Invalid
  authentication credentials"}`, matched the operator-actionable /credential/ pattern,
  classified "permanent", and parked every durable agent paused/"error-unrecoverable".
  These 401s must classify transient + NOT operator-actionable on every surface so in-run
  retry and heartbeat/self-healing error recovery auto-recover. Scope-grant and API-key
  failures stay operator-actionable.
  */
  describe("isTransientAuthCredentialError", () => {
    const rotation401 =
      'Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CcxRi9mwx1NrZmX9qN7p2"}';

    it("classifies the OAuth token-rotation 401 as transient and not operator-actionable", () => {
      expect(isTransientAuthCredentialError(rotation401)).toBe(true);
      expect(isTransientError(rotation401)).toBe(true);
      expect(classifyError(rotation401)).toBe("transient");
      expect(isOperatorActionableAgentError(rotation401)).toBe(false);
    });

    it("matches bare rotation shapes (message-only, token expired, envelope-only)", () => {
      expect(isTransientAuthCredentialError("Invalid authentication credentials")).toBe(true);
      expect(isTransientAuthCredentialError("token_expired: please re-authenticate")).toBe(true);
      expect(isTransientAuthCredentialError('{"type":"error","error":{"type":"authentication_error"}}')).toBe(true);
    });

    it("keeps OAuth scope-grant failures operator-actionable even inside an authentication_error envelope", () => {
      const scopeError =
        '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token does not meet scope requirements"}}';
      expect(isTransientAuthCredentialError(scopeError)).toBe(false);
      expect(isTransientError(scopeError)).toBe(false);
      expect(classifyError(scopeError)).toBe("permanent");
      expect(isOperatorActionableAgentError(scopeError)).toBe(true);
    });

    it("keeps API-key misconfiguration operator-actionable even inside an authentication_error envelope", () => {
      const badApiKey =
        '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
      expect(isTransientAuthCredentialError(badApiKey)).toBe(false);
      expect(classifyError(badApiKey)).toBe("permanent");
      expect(isTransientAuthCredentialError("missing ANTHROPIC_API_KEY")).toBe(false);
      expect(isOperatorActionableAgentError("invalid api key")).toBe(true);
      expect(isOperatorActionableAgentError("missing OPENAI_API_KEY")).toBe(true);
    });

    it("keeps revoked/suspended/subscription credential states operator-actionable inside an authentication_error envelope (PR #2027 review)", () => {
      const shapes = [
        '401 {"type":"error","error":{"type":"authentication_error","message":"Access denied: API key revoked"}}',
        '401 {"type":"error","error":{"type":"authentication_error","message":"account suspended"}}',
        '401 {"type":"error","error":{"type":"authentication_error","message":"subscription inactive"}}',
        '401 {"type":"error","error":{"type":"authentication_error","message":"this API key has been disabled"}}',
        '401 {"type":"error","error":{"type":"authentication_error","message":"credentials deactivated"}}',
        '401 {"type":"error","error":{"type":"authentication_error","message":"account is locked"}}',
      ];
      for (const shape of shapes) {
        expect(isTransientAuthCredentialError(shape)).toBe(false);
        expect(classifyError(shape)).toBe("permanent");
      }
    });

    it("does not match unrelated auth failures or empty input", () => {
      expect(isTransientAuthCredentialError("Authentication failed for provider")).toBe(false);
      expect(isOperatorActionableAgentError("Authentication failed for provider")).toBe(true);
      expect(isTransientAuthCredentialError("")).toBe(false);
      expect(isTransientAuthCredentialError(null as unknown as string)).toBe(false);
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
