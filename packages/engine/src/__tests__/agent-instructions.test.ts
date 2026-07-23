import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentRating, AgentRatingSummary, AgentStore } from "@fusion/core";
import {
  resolveAgentInstructions,
  resolveAgentInstructionsWithRatings,
  buildAgentChatPrompt,
  buildSystemPromptWithInstructions,
  buildPluginPromptSection,
  ensureDefaultHeartbeatProcedureFile,
  resolveAgentHeartbeatProcedure,
} from "../agents/agent-instructions.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-test",
    name: "test-agent",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  } as Agent;
}

function makeRating(overrides: Partial<AgentRating> = {}): AgentRating {
  return {
    id: "rating-1",
    agentId: "agent-test",
    raterType: "user",
    score: 4,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRatingSummary(overrides: Partial<AgentRatingSummary> = {}): AgentRatingSummary {
  return {
    agentId: "agent-test",
    averageScore: 4,
    totalRatings: 1,
    categoryAverages: {},
    recentRatings: [makeRating()],
    trend: "stable",
    ...overrides,
  };
}

describe("resolveAgentInstructions", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-instr-resolve-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns empty string for null agent", async () => {
    const result = await resolveAgentInstructions(null, testDir);
    expect(result).toBe("");
  });

  it("returns empty string for undefined agent", async () => {
    const result = await resolveAgentInstructions(undefined, testDir);
    expect(result).toBe("");
  });

  it("returns empty string for agent with no instructions", async () => {
    const agent = makeAgent();
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("");
  });

  it("returns empty string for agent with empty instructions fields", async () => {
    const agent = makeAgent({ instructionsText: "", instructionsPath: "" });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("");
  });

  it("returns soul-only agent with no instructions", async () => {
    const agent = makeAgent({ soul: "Be thorough and analytical." });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("## Soul\n\nBe thorough and analytical.");
  });

  it("returns memory section when memory is set", async () => {
    const agent = makeAgent({ memory: "Remember to keep CI green." });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toContain("## Agent Memory");
    expect(result).toContain("memory for this agent only");
    expect(result).toContain("Remember to keep CI green.");
  });

  it("omits memory section when memory is empty", async () => {
    const agent = makeAgent({ instructionsText: "Base instructions", memory: "   " });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Base instructions");
    expect(result).not.toContain("## Agent Memory");
  });

  it("uses workspace MEMORY.md when inline memory is empty", async () => {
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"),
      "\nworkspace memory content\n",
      "utf-8",
    );

    const result = await resolveAgentInstructions(makeAgent({ memory: "" }), testDir);
    expect(result).toContain("## Agent Memory");
    expect(result).toContain("workspace memory content");
    expect(result).toContain("_Source: .fusion/agent-memory/agent-test/MEMORY.md_");
  });

  it("renders both inline and workspace memory when both exist", async () => {
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"),
      "workspace memory content",
      "utf-8",
    );

    const result = await resolveAgentInstructions(makeAgent({ memory: "inline memory content" }), testDir);
    expect(result).toContain("inline memory content");
    expect(result).toContain("### Long-term Workspace Memory");
    expect(result).toContain("workspace memory content");
  });

  it("reads workspace memory using sanitized agent id", async () => {
    const weirdId = "Agent X/1";
    await mkdir(join(testDir, ".fusion", "agent-memory", "Agent-X-1"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "Agent-X-1", "MEMORY.md"),
      "sanitized workspace memory",
      "utf-8",
    );

    const result = await resolveAgentInstructions(makeAgent({ id: weirdId, memory: "" }), testDir);
    expect(result).toContain("sanitized workspace memory");
    expect(result).toContain("_Source: .fusion/agent-memory/Agent-X-1/MEMORY.md_");
  });

  it("clamps oversized workspace memory", async () => {
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"),
      "x".repeat(60000),
      "utf-8",
    );

    const result = await resolveAgentInstructions(makeAgent({ memory: "" }), testDir);
    expect(result).toContain("x".repeat(50000));
  });

  it("returns instructionsText when set", async () => {
    const agent = makeAgent({ instructionsText: "Always write tests." });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Always write tests.");
  });

  it("returns file contents when instructionsPath is set", async () => {
    const filePath = join(testDir, "instructions.md");
    await writeFile(filePath, "# Custom Instructions\nUse strict TypeScript.");

    const agent = makeAgent({ instructionsPath: "instructions.md" });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("# Custom Instructions\nUse strict TypeScript.");
  });

  it("ignores absolute instructionsPath for safety", async () => {
    const filePath = join(testDir, "absolute-instructions.md");
    await writeFile(filePath, "Absolute path instructions.");

    const agent = makeAgent({ instructionsPath: filePath, instructionsText: "Inline fallback." });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Inline fallback.");
  });

  it("concatenates instructionsText and file contents with double newline", async () => {
    const filePath = join(testDir, "extra.md");
    await writeFile(filePath, "Extra instructions from file.");

    const agent = makeAgent({
      instructionsText: "Inline instructions.",
      instructionsPath: "extra.md",
    });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Inline instructions.\n\nExtra instructions from file.");
  });

  it("gracefully handles missing instructionsPath file", async () => {
    const agent = makeAgent({
      instructionsText: "Fallback text.",
      instructionsPath: "nonexistent.md",
    });

    const result = await resolveAgentInstructions(agent, testDir);

    // Should return fallback text even when file is missing
    expect(result).toBe("Fallback text.");
  });

  it("gracefully handles unreadable file", async () => {
    const agent = makeAgent({
      instructionsPath: "unreadable.md",
    });

    const result = await resolveAgentInstructions(agent, testDir);

    // Should return empty string when only path is provided but file doesn't exist
    expect(result).toBe("");
  });

  it("trims whitespace from instructionsText", async () => {
    const agent = makeAgent({ instructionsText: "  padded text  " });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("padded text");
  });

  it("trims whitespace from file contents", async () => {
    const filePath = join(testDir, "padded.md");
    await writeFile(filePath, "  padded file content  ");

    const agent = makeAgent({ instructionsPath: "padded.md" });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("padded file content");
  });

  it("ignores empty file contents", async () => {
    const filePath = join(testDir, "empty.md");
    await writeFile(filePath, "   ");

    const agent = makeAgent({
      instructionsText: "Text only.",
      instructionsPath: "empty.md",
    });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Text only.");
  });

  it("rejects path traversal in instructionsPath", async () => {
    const agent = makeAgent({
      instructionsText: "Safe inline.",
      instructionsPath: "../secrets.md",
    });

    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Safe inline.");
  });

  it("rejects non-markdown instruction files", async () => {
    const txtPath = join(testDir, "instructions.txt");
    await writeFile(txtPath, "should not be read");

    const agent = makeAgent({
      instructionsText: "Inline only.",
      instructionsPath: "instructions.txt",
    });

    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Inline only.");
  });

  it("truncates oversized inline instructions", async () => {
    const oversized = "x".repeat(50010);
    const agent = makeAgent({ instructionsText: oversized });

    const result = await resolveAgentInstructions(agent, testDir);
    expect(result.length).toBe(50000);
  });

  it("truncates oversized instructions files", async () => {
    const filePath = join(testDir, "large.md");
    await writeFile(filePath, "y".repeat(50020));

    const agent = makeAgent({ instructionsPath: "large.md" });
    const result = await resolveAgentInstructions(agent, testDir);

    expect(result.length).toBe(50000);
  });

  it("truncates oversized soul", async () => {
    const oversized = "s".repeat(10010);
    const agent = makeAgent({ soul: oversized });

    const result = await resolveAgentInstructions(agent, testDir);
    expect(result.length).toBe(10000 + "## Soul\n\n".length);
  });

  it("places memory section after soul", async () => {
    const filePath = join(testDir, "file-instructions.md");
    await writeFile(filePath, "File-based instructions here.");

    const agent = makeAgent({
      instructionsText: "Inline instructions.",
      instructionsPath: "file-instructions.md",
      soul: "Be methodical and detailed.",
      memory: "Remember that this repository uses pnpm workspaces.",
    });

    const result = await resolveAgentInstructions(agent, testDir);

    const instructionsTextIndex = result.indexOf("Inline instructions.");
    const instructionsFileIndex = result.indexOf("File-based instructions here.");
    const soulIndex = result.indexOf("## Soul");
    const memoryIndex = result.indexOf("## Agent Memory");

    expect(instructionsTextIndex).toBeLessThan(soulIndex);
    expect(instructionsFileIndex).toBeLessThan(soulIndex);
    expect(soulIndex).toBeLessThan(memoryIndex);
    expect(result).toContain("## Agent Memory");
    expect(result).toContain("Remember that this repository uses pnpm workspaces.");
  });
});

describe("resolveAgentInstructions with rating summary", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-instr-ratings-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("adds a performance feedback section when ratings exist", async () => {
    const agent = makeAgent({ instructionsText: "Follow the task prompt." });
    const summary = makeRatingSummary({
      averageScore: 4.26,
      totalRatings: 4,
      trend: "improving",
      categoryAverages: { quality: 4.5, speed: 3.75 },
      recentRatings: [
        makeRating({ id: "r1", score: 5, comment: "Great debugging discipline" }),
        makeRating({ id: "r2", score: 4, comment: "Could communicate blockers sooner" }),
      ],
    });

    const result = await resolveAgentInstructions(agent, testDir, summary);

    expect(result).toContain("Follow the task prompt.");
    expect(result).toContain("## Performance Feedback");
    expect(result).toContain("- Average score: 4.3");
    expect(result).toContain("- Trend: 📈 improving");
    expect(result).toContain("- Category breakdown:");
    expect(result).toContain("  - quality: 4.5");
    expect(result).toContain("  - speed: 3.8");
    expect(result).toContain('  - "Great debugging discipline" (score: 5.0)');
    expect(result).toContain('  - "Could communicate blockers sooner" (score: 4.0)');
  });

  it("places soul and memory sections before performance feedback and after instructions", async () => {
    const agent = makeAgent({
      instructionsText: "Implement the feature.",
      soul: "Be pragmatic and efficient.",
      memory: "Past tasks with flaky tests needed retries.",
    });
    const summary = makeRatingSummary({
      totalRatings: 3,
      trend: "stable",
    });

    const result = await resolveAgentInstructions(agent, testDir, summary);

    // Verify section order: instructionsText → soul → memory → Performance Feedback
    const instructionsIndex = result.indexOf("Implement the feature.");
    const soulIndex = result.indexOf("## Soul");
    const memoryIndex = result.indexOf("## Agent Memory");
    const feedbackIndex = result.indexOf("## Performance Feedback");

    expect(instructionsIndex).toBeLessThan(soulIndex);
    expect(soulIndex).toBeLessThan(memoryIndex);
    expect(memoryIndex).toBeLessThan(feedbackIndex);
    expect(result).toContain("## Agent Memory");
    expect(result).toContain("## Performance Feedback");
  });

  it("shows the correct trend indicator for all trend states", async () => {
    const agent = makeAgent({ instructionsText: "Base instructions" });
    const trends: Array<[AgentRatingSummary["trend"], string]> = [
      ["improving", "📈 improving"],
      ["declining", "📉 declining"],
      ["stable", "➡️ stable"],
      ["insufficient-data", "❓ insufficient-data"],
    ];

    for (const [trend, expected] of trends) {
      const result = await resolveAgentInstructions(
        agent,
        testDir,
        makeRatingSummary({ trend, totalRatings: 10 }),
      );
      expect(result).toContain(`- Trend: ${expected}`);
    }
  });

  it("limits recent feedback to 3 comments and skips unrated comments", async () => {
    const agent = makeAgent();
    const summary = makeRatingSummary({
      totalRatings: 8,
      recentRatings: [
        makeRating({ id: "r1", score: 5, comment: "Most recent note" }),
        makeRating({ id: "r2", score: 4, comment: "Second note" }),
        makeRating({ id: "r3", score: 3 }),
        makeRating({ id: "r4", score: 2, comment: "Third note" }),
        makeRating({ id: "r5", score: 1, comment: "Should be trimmed" }),
      ],
    });

    const result = await resolveAgentInstructions(agent, testDir, summary);

    expect(result).toContain("- Recent feedback:");
    expect(result).toContain('  - "Most recent note" (score: 5.0)');
    expect(result).toContain('  - "Second note" (score: 4.0)');
    expect(result).toContain('  - "Third note" (score: 2.0)');
    expect(result).not.toContain("Should be trimmed");
  });

  it("renders index-mode memory instead of full body", async () => {
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"),
      "## Delegation\n\nUse concise asks\n",
      "utf-8",
    );

    const result = await resolveAgentInstructions(makeAgent({ memory: "inline memory" }), testDir, undefined, "index");
    expect(result).toContain("Memory is provided in index mode");
    expect(result).toContain("## Agent Memory Index (use fn_memory_search / fn_memory_get to read)");
    expect(result).not.toContain("inline memory");
  });

  it("omits memory section in off mode", async () => {
    const result = await resolveAgentInstructions(makeAgent({ memory: "inline memory" }), testDir, undefined, "off");
    expect(result).not.toContain("## Agent Memory");
    expect(result).not.toContain("inline memory");
  });

  it("omits category breakdown when category averages are empty", async () => {
    const result = await resolveAgentInstructions(
      makeAgent({ instructionsText: "Do work" }),
      testDir,
      makeRatingSummary({ totalRatings: 2, categoryAverages: {} }),
    );

    expect(result).not.toContain("- Category breakdown:");
  });

  it("does not add performance feedback when totalRatings is zero", async () => {
    const result = await resolveAgentInstructions(
      makeAgent({ instructionsText: "Do work" }),
      testDir,
      makeRatingSummary({ totalRatings: 0 }),
    );

    expect(result).toBe("Do work");
    expect(result).not.toContain("## Performance Feedback");
  });

  it("does not add performance feedback when rating summary is undefined", async () => {
    const result = await resolveAgentInstructions(
      makeAgent({ instructionsText: "Do work" }),
      testDir,
      undefined,
    );

    expect(result).toBe("Do work");
    expect(result).not.toContain("## Performance Feedback");
  });
});

describe("resolveAgentInstructionsWithRatings", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-instr-with-ratings-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns empty string for null agent", async () => {
    const store = {
      getRatingSummary: vi.fn(),
    } as unknown as AgentStore;

    const result = await resolveAgentInstructionsWithRatings(null, testDir, store);

    expect(result).toBe("");
    expect(store.getRatingSummary).not.toHaveBeenCalled();
  });

  it("returns base instructions when no agent store is provided", async () => {
    const result = await resolveAgentInstructionsWithRatings(
      makeAgent({ instructionsText: "Inline instructions" }),
      testDir,
      undefined,
    );

    expect(result).toBe("Inline instructions");
  });

  it("injects performance feedback when store returns ratings", async () => {
    const store = {
      getRatingSummary: vi.fn().mockResolvedValue(
        makeRatingSummary({
          averageScore: 3.333,
          totalRatings: 3,
          trend: "stable",
          categoryAverages: { codeQuality: 4.95 },
          recentRatings: [makeRating({ score: 4, comment: "Solid implementation" })],
        }),
      ),
    } as unknown as AgentStore;

    const result = await resolveAgentInstructionsWithRatings(
      makeAgent({ instructionsText: "Inline instructions" }),
      testDir,
      store,
    );

    expect(store.getRatingSummary).toHaveBeenCalledWith("agent-test");
    expect(result).toContain("Inline instructions");
    expect(result).toContain("## Performance Feedback");
    expect(result).toContain("- Average score: 3.3");
    expect(result).toContain("  - codeQuality: 5.0");
  });

  it("falls back to base instructions when rating lookup fails", async () => {
    const store = {
      getRatingSummary: vi.fn().mockRejectedValue(new Error("db unavailable")),
    } as unknown as AgentStore;

    const result = await resolveAgentInstructionsWithRatings(
      makeAgent({ instructionsText: "Fallback instructions" }),
      testDir,
      store,
    );

    expect(store.getRatingSummary).toHaveBeenCalledWith("agent-test");
    expect(result).toBe("Fallback instructions");
  });

  it("does not query ratings when agent id is empty", async () => {
    const store = {
      getRatingSummary: vi.fn(),
    } as unknown as AgentStore;

    const result = await resolveAgentInstructionsWithRatings(
      makeAgent({ id: "", instructionsText: "Fallback instructions" }),
      testDir,
      store,
    );

    expect(store.getRatingSummary).not.toHaveBeenCalled();
    expect(result).toBe("Fallback instructions");
  });
});

describe("buildAgentChatPrompt", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-chat-prompt-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("builds an identity-aware prompt with soul, memory, instructions, and project memory", async () => {
    await mkdir(join(testDir, ".fusion", "memory"), { recursive: true });
    await writeFile(join(testDir, ".fusion", "memory", "MEMORY.md"), "Project preference: avoid force pushes.");

    const agent = makeAgent({
      name: "Avery",
      title: "Senior Engineer",
      role: "reviewer",
      instructionsText: "Always include focused tests.",
      soul: "Be calm, direct, and empathetic.",
      memory: "The team values short progress updates.",
    });

    const prompt = await buildAgentChatPrompt({
      agent,
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      includeProjectMemory: true,
    });

    expect(prompt).toContain("You are a chat assistant.");
    expect(prompt).toContain("## Custom Instructions");
    expect(prompt).toContain(
      "## Identity\n\nYou are Avery, Senior Engineer (agent ID: agent-test, role: reviewer).",
    );
    expect(prompt).toContain("Always include focused tests.");
    expect(prompt).toContain("## Soul\n\nBe calm, direct, and empathetic.");
    expect(prompt).toContain("## Agent Memory");
    expect(prompt).toContain("The team values short progress updates.");
    expect(prompt).toContain("## Project Memory\n\nProject preference: avoid force pushes.");
  });
});

describe("buildSystemPromptWithInstructions", () => {
  it("returns base prompt when instructions are empty", () => {
    const result = buildSystemPromptWithInstructions("Base prompt", "");
    expect(result).toBe("Base prompt");
  });

  it("returns base prompt when instructions are whitespace only", () => {
    const result = buildSystemPromptWithInstructions("Base prompt", "   ");
    expect(result).toBe("Base prompt");
  });

  it("appends instructions block to base prompt", () => {
    const result = buildSystemPromptWithInstructions(
      "Base prompt",
      "Use strict TypeScript.",
    );
    expect(result).toBe(
      "Base prompt\n\n## Custom Instructions\n\nUse strict TypeScript.",
    );
  });
});

describe("buildPluginPromptSection", () => {
  it("returns empty string when pluginRunner is undefined", async () => {
    await expect(buildPluginPromptSection("triage", undefined)).resolves.toBe("");
  });

  it("returns empty string when no contributions match", async () => {
    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockResolvedValue([]),
    };

    await expect(buildPluginPromptSection("triage", pluginRunner as any)).resolves.toBe("");
  });

  it("formats grouped plugin sections and prepend-before-append ordering", async () => {
    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockResolvedValue([
        { pluginId: "plugin-b", contribution: { surface: "triage", content: "append B1" }, config: {} },
        { pluginId: "plugin-a", contribution: { surface: "triage", content: "prepend A1", position: "prepend" }, config: {} },
        { pluginId: "plugin-a", contribution: { surface: "triage", content: "prepend A2", position: "prepend" }, config: {} },
        { pluginId: "plugin-c", contribution: { surface: "triage", content: "append C1", position: "append" }, config: {} },
      ]),
    };

    const result = await buildPluginPromptSection("triage", pluginRunner as any);

    expect(result).toContain("## Plugin: plugin-a\n\nprepend A1\n\nprepend A2");
    expect(result).toContain("## Plugin: plugin-b\n\nappend B1");
    expect(result).toContain("## Plugin: plugin-c\n\nappend C1");
    expect(result.indexOf("## Plugin: plugin-a")).toBeLessThan(result.indexOf("## Plugin: plugin-b"));
  });

  it("keeps passing and no-condition contributions from the condition-aware runner", async () => {
    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockResolvedValue([
        { pluginId: "plugin-a", contribution: { surface: "triage", content: "passing", condition: 'settings["mode"] === "on"' }, config: {} },
        { pluginId: "plugin-a", contribution: { surface: "triage", content: "always" }, config: {} },
        { pluginId: "plugin-b", contribution: { surface: "triage", content: "append", position: "append" }, config: {} },
      ]),
    };

    const result = await buildPluginPromptSection("triage", pluginRunner as any);

    expect(pluginRunner.getPromptContributionsForSurface).toHaveBeenCalledWith("triage");
    expect(result).toContain("passing\n\nalways");
    expect(result).toContain("## Plugin: plugin-b\n\nappend");
    expect(result).not.toContain("gated out");
  });
});

describe("diagnostics logging", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-instr-diagnostics-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it("logs exactly once when oversized instructionsText is truncated", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeAgent({ instructionsText: "x".repeat(50_010) });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("instructionsText exceeded max length");
    expect(result.length).toBe(50_000);
  });

  it("logs exactly once when oversized instructionsPath file content is truncated", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(join(testDir, "large.md"), "y".repeat(50_020));
    const agent = makeAgent({ instructionsPath: "large.md" });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("instructions file content exceeded max length");
    expect(result.length).toBe(50_000);
  });

  it("logs exactly once when oversized soul is truncated", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeAgent({ soul: "s".repeat(10_010) });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("soul exceeded max length");
    expect(result.length).toBe(10_000 + "## Soul\n\n".length);
  });

  it("logs exactly once when oversized memory is truncated", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = "m".repeat(50_010);
    const agent = makeAgent({ memory });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("memory exceeded max length");
    expect(result).toContain("## Agent Memory");
    expect(result).toContain(memory.slice(0, 50_000));
  });

  it("logs exactly once when instructionsPath is too long", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeAgent({ instructionsPath: `${"a".repeat(501)}.md` });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("instructionsPath too long");
    expect(result).toBe("");
  });

  it("logs exactly once when instructionsPath does not end in .md", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(join(testDir, "instructions.txt"), "plain text");
    const agent = makeAgent({ instructionsPath: "instructions.txt" });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("must end in .md");
    expect(result).toBe("");
  });

  it("logs exactly once when instructionsPath is absolute", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeAgent({ instructionsPath: "/etc/passwd.md" });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("must be project-relative");
    expect(result).toBe("");
  });

  it("logs exactly once when instructionsPath attempts traversal", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeAgent({ instructionsPath: "../secrets.md" });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("traversal is not allowed");
    expect(result).toBe("");
  });

  it("logs exactly once when instructionsPath file is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeAgent({
      instructionsText: "Fallback text.",
      instructionsPath: "nonexistent.md",
    });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("file not found");
    expect(result).toBe("Fallback text.");
  });

  it("logs exactly once when project memory read fails in buildAgentChatPrompt", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(join(testDir, ".fusion", "memory", "MEMORY.md"), { recursive: true });

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({
        name: "Avery",
        role: "reviewer",
      }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      includeProjectMemory: true,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Failed to read project memory");
    expect(prompt).toContain("## Identity");
  });
});

describe("heartbeat procedure path compatibility", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-heartbeat-proc-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("loads canonical display-name heartbeat procedure paths", async () => {
    const relPath = ".fusion/agents/ceo-agent2736/HEARTBEAT.md";
    await mkdir(join(testDir, ".fusion", "agents", "ceo-agent2736"), { recursive: true });
    await writeFile(join(testDir, relPath), "Canonical heartbeat", "utf-8");

    const content = await resolveAgentHeartbeatProcedure(
      makeAgent({ id: "agent2736", heartbeatProcedurePath: relPath }),
      testDir,
    );

    expect(content).toBe("Canonical heartbeat");
  });

  it("loads legacy id-only heartbeat procedure paths", async () => {
    const relPath = ".fusion/agents/agent-legacy/HEARTBEAT.md";
    await mkdir(join(testDir, ".fusion", "agents", "agent-legacy"), { recursive: true });
    await writeFile(join(testDir, relPath), "Legacy heartbeat", "utf-8");

    const content = await resolveAgentHeartbeatProcedure(
      makeAgent({ id: "agent-legacy", heartbeatProcedurePath: relPath }),
      testDir,
    );

    expect(content).toBe("Legacy heartbeat");
  });

  it("rejects traversal heartbeat procedure paths", async () => {
    const content = await resolveAgentHeartbeatProcedure(
      makeAgent({ heartbeatProcedurePath: "../outside.md" }),
      testDir,
    );
    expect(content).toBeNull();
  });

  it("seeds default heartbeat procedure only for valid project-relative markdown paths", async () => {
    const seeded = await ensureDefaultHeartbeatProcedureFile(
      testDir,
      ".fusion/agents/ceo-agent2736/HEARTBEAT.md",
      "Default",
    );
    expect(seeded).toBeTruthy();

    const invalid = await ensureDefaultHeartbeatProcedureFile(testDir, "../outside.md", "Default");
    expect(invalid).toBeNull();
  });
});
