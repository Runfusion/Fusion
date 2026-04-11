import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  startAgentGeneration,
  generateAgentSpec,
  getAgentGenerationSession,
  cleanupAgentGenerationSession,
  checkRateLimit,
  getRateLimitResetTime,
  parseGenerationResponse,
  __resetAgentGenerationState,
  RateLimitError,
  SessionNotFoundError,
} from "./agent-generation.js";

// Counter for unique IPs per test
let ipCounter = 0;
function getUniqueIp(): string {
  return `127.0.0.${++ipCounter}`;
}

describe("agent-generation module", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAgentGenerationState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("startAgentGeneration", () => {
    it("creates a session with valid role description", async () => {
      const mockIp = getUniqueIp();
      const session = await startAgentGeneration(mockIp, "Senior frontend code reviewer");

      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe("string");
      expect(session.roleDescription).toBe("Senior frontend code reviewer");
      expect(session.spec).toBeUndefined();
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.updatedAt).toBeInstanceOf(Date);
    });

    it("does not expose IP in the public session", async () => {
      const mockIp = getUniqueIp();
      const session = await startAgentGeneration(mockIp, "Test role");

      expect((session as unknown as Record<string, unknown>).ip).toBeUndefined();
    });

    it("enforces rate limiting", async () => {
      const mockIp = getUniqueIp();
      // Create max sessions (10 per hour)
      for (let i = 0; i < 10; i++) {
        await startAgentGeneration(mockIp, `Role ${i}`);
      }

      // 11th session should fail
      await expect(startAgentGeneration(mockIp, "One more")).rejects.toThrow(RateLimitError);
    });

    it("allows new sessions after rate limit window expires", async () => {
      const mockIp = getUniqueIp();
      for (let i = 0; i < 10; i++) {
        await startAgentGeneration(mockIp, `Role ${i}`);
      }

      // Advance time by 1 hour + 1 minute
      vi.advanceTimersByTime(61 * 60 * 1000);

      const session = await startAgentGeneration(mockIp, "New role after reset");
      expect(session.id).toBeDefined();
    });

    it("generates different session IDs for each session", async () => {
      const ip1 = getUniqueIp();
      const ip2 = getUniqueIp();
      const session1 = await startAgentGeneration(ip1, "Role 1");
      const session2 = await startAgentGeneration(ip2, "Role 2");

      expect(session1.id).not.toBe(session2.id);
    });

    it("rate limits independently per IP", async () => {
      const ip1 = getUniqueIp();
      const ip2 = getUniqueIp();

      for (let i = 0; i < 10; i++) {
        await startAgentGeneration(ip1, `Role ${i}`);
      }

      // ip2 should still work
      const session = await startAgentGeneration(ip2, "Role from another IP");
      expect(session.id).toBeDefined();
    });
  });

  describe("generateAgentSpec", () => {
    it("throws SessionNotFoundError for non-existent session", async () => {
      await expect(
        generateAgentSpec("non-existent-session-id", "/tmp")
      ).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe("getAgentGenerationSession", () => {
    it("returns session after creation", async () => {
      const mockIp = getUniqueIp();
      const created = await startAgentGeneration(mockIp, "Test role");

      const retrieved = getAgentGenerationSession(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.roleDescription).toBe("Test role");
    });

    it("returns undefined for non-existent session", () => {
      const result = getAgentGenerationSession("non-existent");
      expect(result).toBeUndefined();
    });

    it("returns undefined after cleanup", async () => {
      const mockIp = getUniqueIp();
      const created = await startAgentGeneration(mockIp, "Test role");

      cleanupAgentGenerationSession(created.id);

      const result = getAgentGenerationSession(created.id);
      expect(result).toBeUndefined();
    });
  });

  describe("cleanupAgentGenerationSession", () => {
    it("removes session", async () => {
      const mockIp = getUniqueIp();
      const created = await startAgentGeneration(mockIp, "Test role");

      cleanupAgentGenerationSession(created.id);

      expect(getAgentGenerationSession(created.id)).toBeUndefined();
    });

    it("is idempotent for non-existent session", () => {
      expect(() => cleanupAgentGenerationSession("non-existent")).not.toThrow();
    });
  });

  describe("checkRateLimit", () => {
    beforeEach(() => {
      __resetAgentGenerationState();
    });

    it("allows first request from new IP", () => {
      expect(checkRateLimit("1.2.3.4")).toBe(true);
    });

    it("blocks after exceeding limit", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("1.2.3.4");
      }
      expect(checkRateLimit("1.2.3.4")).toBe(false);
    });

    it("allows requests after window expires", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("1.2.3.4");
      }

      vi.advanceTimersByTime(61 * 60 * 1000);

      expect(checkRateLimit("1.2.3.4")).toBe(true);
    });
  });

  describe("getRateLimitResetTime", () => {
    it("returns null for unknown IP", () => {
      expect(getRateLimitResetTime("unknown")).toBeNull();
    });

    it("returns a date after first request", () => {
      checkRateLimit("1.2.3.4");
      const resetTime = getRateLimitResetTime("1.2.3.4");

      expect(resetTime).toBeInstanceOf(Date);
      expect(resetTime!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("parseGenerationResponse", () => {
    it("parses valid JSON response", () => {
      const json = JSON.stringify({
        title: "Senior Frontend Reviewer",
        icon: "🔍",
        role: "reviewer",
        description: "Reviews frontend code for quality",
        systemPrompt: "# Role\nYou are a senior frontend reviewer.",
        thinkingLevel: "medium",
        maxTurns: 25,
      });

      const spec = parseGenerationResponse(json);

      expect(spec.title).toBe("Senior Frontend Reviewer");
      expect(spec.icon).toBe("🔍");
      expect(spec.role).toBe("reviewer");
      expect(spec.description).toBe("Reviews frontend code for quality");
      expect(spec.systemPrompt).toBe("# Role\nYou are a senior frontend reviewer.");
      expect(spec.thinkingLevel).toBe("medium");
      expect(spec.maxTurns).toBe(25);
    });

    it("parses JSON wrapped in markdown code block", () => {
      const inner = JSON.stringify({
        title: "Test Agent",
        icon: "🤖",
        role: "custom",
        description: "A test agent",
        systemPrompt: "Test prompt",
        thinkingLevel: "off",
        maxTurns: 10,
      });
      const wrapped = "```json\n" + inner + "\n```";

      const spec = parseGenerationResponse(wrapped);
      expect(spec.title).toBe("Test Agent");
    });

    it("parses JSON with surrounding text", () => {
      const json = JSON.stringify({
        title: "Test Agent",
        icon: "🤖",
        role: "custom",
        description: "A test agent",
        systemPrompt: "Test prompt",
        thinkingLevel: "off",
        maxTurns: 10,
      });
      const text = `Here is the specification:\n${json}\nHope this helps!`;

      const spec = parseGenerationResponse(text);
      expect(spec.title).toBe("Test Agent");
    });

    it("applies defaults for missing fields", () => {
      const json = JSON.stringify({});

      const spec = parseGenerationResponse(json);

      expect(spec.title).toBe("Custom Agent");
      expect(spec.icon).toBe("🤖");
      expect(spec.role).toBe("custom");
      expect(spec.description).toBe("");
      expect(spec.systemPrompt).toBe("");
      expect(spec.thinkingLevel).toBe("off");
      expect(spec.maxTurns).toBe(10);
    });

    it("truncates title to 60 characters", () => {
      const longTitle = "A".repeat(100);
      const json = JSON.stringify({
        title: longTitle,
        icon: "🤖",
        role: "custom",
        description: "test",
        systemPrompt: "test",
        thinkingLevel: "off",
        maxTurns: 10,
      });

      const spec = parseGenerationResponse(json);
      expect(spec.title.length).toBe(60);
    });

    it("clamps maxTurns to valid range", () => {
      const json = JSON.stringify({
        title: "Test",
        maxTurns: 999,
      });

      const spec = parseGenerationResponse(json);
      expect(spec.maxTurns).toBe(500);

      const json2 = JSON.stringify({ title: "Test", maxTurns: -5 });
      const spec2 = parseGenerationResponse(json2);
      expect(spec2.maxTurns).toBe(1); // clamped to minimum
    });

    it("defaults invalid thinkingLevel to off", () => {
      const json = JSON.stringify({
        title: "Test",
        thinkingLevel: "ultra",
      });

      const spec = parseGenerationResponse(json);
      expect(spec.thinkingLevel).toBe("off");
    });

    it("repairs JSON with trailing commas", () => {
      const broken = '{"title":"Test","icon":"X","role":"custom","description":"d","systemPrompt":"s","thinkingLevel":"off","maxTurns":10,}';
      const spec = parseGenerationResponse(broken);
      expect(spec.title).toBe("Test");
    });

    it("throws for non-JSON text", () => {
      expect(() => parseGenerationResponse("Hello world, this is not JSON")).toThrow(
        "AI returned no valid JSON"
      );
    });

    it("throws for empty text", () => {
      expect(() => parseGenerationResponse("")).toThrow("AI returned no valid JSON");
    });
  });

  describe("TTL cleanup", () => {
    it("sessions are retrievable within TTL", async () => {
      const mockIp = getUniqueIp();
      const session = await startAgentGeneration(mockIp, "Test role");

      // Session should exist within TTL
      expect(getAgentGenerationSession(session.id)).toBeDefined();

      // Advance to just before TTL
      vi.advanceTimersByTime(29 * 60 * 1000);

      expect(getAgentGenerationSession(session.id)).toBeDefined();
    });

    it("session data is accessible after creation", async () => {
      const mockIp = getUniqueIp();
      const session = await startAgentGeneration(mockIp, "Security auditor role");

      const retrieved = getAgentGenerationSession(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.roleDescription).toBe("Security auditor role");
    });
  });

  describe("prompt override support", () => {
    // Mock createKbAgent to capture the systemPrompt passed to it
    let capturedSystemPrompt: string | undefined;

    beforeEach(async () => {
      capturedSystemPrompt = undefined;
      // Mock createKbAgent before tests run
      vi.doMock("@fusion/engine", () => ({
        createKbAgent: vi.fn(async (options: { cwd: string; systemPrompt: string; tools: string }) => {
          capturedSystemPrompt = options.systemPrompt;
          const messages: Array<{ role: string; content: string }> = [];
          return {
            session: {
              state: { messages },
              prompt: vi.fn(async () => {
                messages.push({
                  role: "assistant",
                  content: JSON.stringify({ title: "Test Agent", description: "A test agent", systemPrompt: "Test prompt", tools: [], maxTurns: 10, tags: [] }),
                });
              }),
              dispose: vi.fn(),
            },
          };
        }),
      }));
      // Reset the module to pick up the mock
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it("generates spec with default AGENT_GENERATION_SYSTEM_PROMPT when no overrides provided", async () => {
      const { generateAgentSpec: genSpec, startAgentGeneration: startGen, AGENT_GENERATION_SYSTEM_PROMPT } = await import("./agent-generation.js");

      const session = await startGen(getUniqueIp(), "Test role");
      const spec = await genSpec(session.id, "/tmp");

      // The spec should be empty since we mocked an empty response
      expect(spec).toBeDefined();
      // The system prompt should be EXACTLY the constant when no overrides
      expect(capturedSystemPrompt).toBe(AGENT_GENERATION_SYSTEM_PROMPT);
    });

    it("generates spec with override system prompt when overrides provided", async () => {
      const { generateAgentSpec: genSpec, startAgentGeneration: startGen } = await import("./agent-generation.js");

      const customPrompt = "CUSTOM AGENT GENERATION PROMPT";
      const overrides = { "agent-generation-system": customPrompt };

      const session = await startGen(getUniqueIp(), "Test role");
      const spec = await genSpec(session.id, "/tmp", overrides);

      // The spec should be empty since we mocked an empty response
      expect(spec).toBeDefined();
      // The system prompt should be EXACTLY the custom override
      expect(capturedSystemPrompt).toBe(customPrompt);
    });

    it("falls back to AGENT_GENERATION_SYSTEM_PROMPT constant when override key not recognized", async () => {
      const { generateAgentSpec: genSpec, startAgentGeneration: startGen, AGENT_GENERATION_SYSTEM_PROMPT } = await import("./agent-generation.js");

      // Provide an override with a non-existent key
      const overrides = { "non-existent-key": "Some prompt" };

      const session = await startGen(getUniqueIp(), "Test role");
      const spec = await genSpec(session.id, "/tmp", overrides);

      // Should fall back to EXACTLY the constant
      expect(spec).toBeDefined();
      expect(capturedSystemPrompt).toBe(AGENT_GENERATION_SYSTEM_PROMPT);
    });

    it("falls back to AGENT_GENERATION_SYSTEM_PROMPT constant when resolvePrompt returns empty", async () => {
      const { generateAgentSpec: genSpec, startAgentGeneration: startGen, AGENT_GENERATION_SYSTEM_PROMPT } = await import("./agent-generation.js");

      // Empty overrides should still get the default constant
      const overrides = { "agent-generation-system": "" };

      const session = await startGen(getUniqueIp(), "Test role");
      const spec = await genSpec(session.id, "/tmp", overrides);

      expect(spec).toBeDefined();
      expect(capturedSystemPrompt).toBe(AGENT_GENERATION_SYSTEM_PROMPT);
    });

    it("uses EXACT override when override is a non-empty string", async () => {
      const { generateAgentSpec: genSpec, startAgentGeneration: startGen } = await import("./agent-generation.js");

      // Exact override string
      const customPrompt = "EXACT CUSTOM PROMPT TEXT";
      const overrides = { "agent-generation-system": customPrompt };

      const session = await startGen(getUniqueIp(), "Test role");
      const spec = await genSpec(session.id, "/tmp", overrides);

      expect(spec).toBeDefined();
      expect(capturedSystemPrompt).toBe(customPrompt);
    });
  });
});
