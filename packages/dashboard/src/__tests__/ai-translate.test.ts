import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateTranslateRequest,
  parseTranslateResponse,
  translateText,
  MAX_TRANSLATE_TEXT_LENGTH,
  MIN_TRANSLATE_TEXT_LENGTH,
  checkRateLimit,
  checkTranslateRateLimit,
  resetTranslateRateLimits,
  MAX_TRANSLATE_REQUESTS_PER_HOUR,
  ValidationError,
  AiServiceError,
} from "../ai-translate.js";
import { __resetRefineState } from "../ai-refine.js";

const { mockCreateFnAgent, mockResolveMcpServersForStore } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockResolveMcpServersForStore: vi.fn().mockResolvedValue({ servers: [], errors: [] }),
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  createFnAgent: mockCreateFnAgent,
  resolveMcpServersForStore: mockResolveMcpServersForStore,
}));

function mockAgentWithAssistantText(text: string) {
  mockCreateFnAgent.mockResolvedValue({
    session: {
      state: { messages: [{ role: "assistant", content: text }] },
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
  });
}

describe("ai-translate module", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetRefineState();
    resetTranslateRateLimits();
    vi.clearAllMocks();
    mockCreateFnAgent.mockResolvedValue(null);
    mockResolveMcpServersForStore.mockResolvedValue({ servers: [], errors: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("validateTranslateRequest", () => {
    it("accepts title and body with a supported target locale", () => {
      const result = validateTranslateRequest(
        { title: "Bonjour", body: "Ceci est un test" },
        "en",
      );
      expect(result).toEqual({
        fields: { title: "Bonjour", body: "Ceci est un test" },
        targetLocale: "en",
        sourceLocale: undefined,
      });
    });

    it("accepts title-only or body-only fields", () => {
      expect(validateTranslateRequest({ title: "Hello world" }, "fr").fields).toEqual({
        title: "Hello world",
      });
      expect(validateTranslateRequest({ body: "Hello world body text" }, "es").fields).toEqual({
        body: "Hello world body text",
      });
    });

    it("rejects missing fields object", () => {
      expect(() => validateTranslateRequest(null, "en")).toThrow(ValidationError);
      expect(() => validateTranslateRequest(undefined, "en")).toThrow("fields is required");
    });

    it("rejects empty combined text", () => {
      expect(() => validateTranslateRequest({ title: "   ", body: "" }, "en")).toThrow(
        ValidationError,
      );
    });

    it("rejects oversized text", () => {
      expect(() =>
        validateTranslateRequest({ body: "x".repeat(MAX_TRANSLATE_TEXT_LENGTH + 1) }, "en"),
      ).toThrow(`must not exceed ${MAX_TRANSLATE_TEXT_LENGTH}`);
    });

    it("rejects invalid targetLocale", () => {
      expect(() => validateTranslateRequest({ title: "Hi" }, "de")).toThrow(ValidationError);
      expect(() => validateTranslateRequest({ title: "Hi" }, "de")).toThrow("targetLocale must be");
    });

    it("accepts optional sourceLocale hint", () => {
      const result = validateTranslateRequest({ title: "Hola" }, "en", "es");
      expect(result.sourceLocale).toBe("es");
    });

    it("exports a positive min length constant", () => {
      expect(MIN_TRANSLATE_TEXT_LENGTH).toBeGreaterThan(0);
    });
  });

  describe("parseTranslateResponse", () => {
    it("parses a plain JSON object", () => {
      const fields = parseTranslateResponse(
        JSON.stringify({ title: "Hello", body: "World" }),
        { title: "Bonjour", body: "Monde" },
      );
      expect(fields).toEqual({ title: "Hello", body: "World" });
    });

    it("strips markdown fences around JSON", () => {
      const fields = parseTranslateResponse(
        "```json\n{\"title\":\"Hello\",\"body\":\"World\"}\n```",
        { title: "Bonjour", body: "Monde" },
      );
      expect(fields).toEqual({ title: "Hello", body: "World" });
    });

    it("falls back to original title when model omits it", () => {
      const fields = parseTranslateResponse(
        JSON.stringify({ body: "Only body" }),
        { title: "Original title", body: "Original body" },
      );
      expect(fields.title).toBe("Original title");
      expect(fields.body).toBe("Only body");
    });

    it("throws AiServiceError for non-JSON", () => {
      expect(() => parseTranslateResponse("not json at all", { title: "t" })).toThrow(
        AiServiceError,
      );
    });
  });

  /*
  FNXC:GitHubImportTranslate 2026-07-17-12:50:
  FN-8230 reserves cost only for uncached model calls, but the ceiling must allow every one of
  the 300 issues a user can traverse from the import fetch cap, while still rejecting overflow.
  */
  describe("translate-only rate budget", () => {
    it("allows one complete 300-item traversal and rejects the next uncached call", () => {
      const ip = "10.0.0.2";
      for (let page = 0; page < 10; page++) {
        expect(checkTranslateRateLimit(ip, 30)).toBe(true);
      }
      expect(MAX_TRANSLATE_REQUESTS_PER_HOUR).toBe(300);
      expect(checkTranslateRateLimit(ip, 1)).toBe(false);
    });
  });

  describe("translateText", () => {
    it("returns translated fields from the AI agent", async () => {
      mockAgentWithAssistantText(JSON.stringify({ title: "Hello", body: "This is a test" }));

      const result = await translateText(
        {
          fields: { title: "Bonjour", body: "Ceci est un test" },
          targetLocale: "en",
          sourceLocale: "fr",
        },
        "/tmp/project",
      );

      expect(result).toEqual({ title: "Hello", body: "This is a test" });
      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/project",
          tools: "readonly",
        }),
      );
    });

    it("throws when the AI engine is unavailable", async () => {
      mockCreateFnAgent.mockResolvedValueOnce(null);
      await expect(
        translateText(
          { fields: { title: "Bonjour" }, targetLocale: "en" },
          "/tmp/project",
        ),
      ).rejects.toThrow("Failed to initialize AI agent");
    });

    it("shares the refine rate-limit helper", () => {
      // Sanity: re-exported checkRateLimit is callable (shared budget with refine).
      expect(checkRateLimit("10.0.0.1")).toBe(true);
    });
  });
});
