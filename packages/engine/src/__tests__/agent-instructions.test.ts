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
} from "../agent-instructions.js";

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
    expect(result).toBe("## Memory\n\nRemember to keep CI green.");
  });

  it("omits memory section when memory is empty", async () => {
    const agent = makeAgent({ instructionsText: "Base instructions", memory: "   " });
    const result = await resolveAgentInstructions(agent, testDir);
    expect(result).toBe("Base instructions");
    expect(result).not.toContain("## Memory");
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
    const memoryIndex = result.indexOf("## Memory");

    expect(instructionsTextIndex).toBeLessThan(soulIndex);
    expect(instructionsFileIndex).toBeLessThan(soulIndex);
    expect(soulIndex).toBeLessThan(memoryIndex);
    expect(result).toContain("## Memory\n\nRemember that this repository uses pnpm workspaces.");
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
    const memoryIndex = result.indexOf("## Memory");
    const feedbackIndex = result.indexOf("## Performance Feedback");

    expect(instructionsIndex).toBeLessThan(soulIndex);
    expect(soulIndex).toBeLessThan(memoryIndex);
    expect(memoryIndex).toBeLessThan(feedbackIndex);
    expect(result).toContain("## Memory");
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
    await mkdir(join(testDir, ".fusion"), { recursive: true });
    await writeFile(join(testDir, ".fusion", "memory.md"), "Project preference: avoid force pushes.");

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
    expect(prompt).toContain("## Memory\n\nThe team values short progress updates.");
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
