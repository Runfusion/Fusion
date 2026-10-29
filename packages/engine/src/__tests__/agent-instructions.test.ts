import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST,
  MEMORY_PRE_STEERING_MARKER,
  registerMemoryBackend,
  __resetPerTurnRecallDedupForTests,
  type Agent,
  type AgentRating,
  type AgentRatingSummary,
  type AgentStore,
  type MemorySearchResult,
  type Settings,
} from "@fusion/core";
import {
  MAX_MEMORY_LENGTH,
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

  it("composes every exported workflow-owner identity exactly once", async () => {
    for (const definition of BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST) {
      const result = await resolveAgentInstructions(makeAgent({
        id: `agent-${definition.role}`,
        name: definition.name,
        role: definition.role,
        roles: [definition.role],
        instructionsText: definition.instructionsText,
        soul: definition.soul,
      }), testDir);
      expect(result.split(definition.instructionsText)).toHaveLength(2);
      expect(result.split("## Soul")).toHaveLength(2);
      expect(result.split(definition.soul)).toHaveLength(2);
    }
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

  it("does not add a default inline identity beside a preserved custom path", async () => {
    const definition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === "executor")!;
    await writeFile(join(testDir, "operator-executor.md"), "operator-owned executor instructions");

    const result = await resolveAgentInstructions(makeAgent({
      instructionsPath: "operator-executor.md",
      instructionsText: "",
      soul: definition.soul,
    }), testDir);

    expect(result).toContain("operator-owned executor instructions");
    expect(result).not.toContain(definition.instructionsText);
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

  /*
  FNXC:OperatorLanguage 2026-09-15-07:18:
  Chat turns only mirror the operator's language by accident of the model; the explicit global
  operatorLanguage setting must produce a directive in the rebuilt system prompt, and — the
  byte-identical-promise regression guard — produce NOTHING when unset/auto.
  */
  it("injects the operator-language directive when the setting names a language", async () => {
    const agent = makeAgent({ name: "Avery", role: "reviewer" });
    const prompt = await buildAgentChatPrompt({
      agent,
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      settings: { operatorLanguage: "sk" },
    });
    expect(prompt).toContain("## Operator Language");
    expect(prompt).toContain("Slovak (slovenčina)");
  });

  it("omits the operator-language directive for auto/unset settings", async () => {
    const agent = makeAgent({ name: "Avery", role: "reviewer" });
    const base = await buildAgentChatPrompt({ agent, rootDir: testDir, basePrompt: "You are a chat assistant." });
    const auto = await buildAgentChatPrompt({
      agent,
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      settings: { operatorLanguage: "auto" },
    });
    expect(base).not.toContain("## Operator Language");
    expect(auto).toBe(base);
  });

  /*
  FNXC:ChatContextBudget 2026-08-20-11:56:
  memoryCapChars bounds the memory sections of the chat system prompt (user
  requirement: agent chat must work on 64K-context models). Oversized sources
  are inlined as bounded heading indexes; the full content stays reachable via
  fn_memory_search / fn_memory_get. Without a cap (engine lanes) the legacy
  full injection is preserved — these tests pin both sides of that contract.
  */
  it("demotes oversized project memory to a bounded heading index when memoryCapChars is set", async () => {
    await mkdir(join(testDir, ".fusion", "memory"), { recursive: true });
    const body = "SECRET-PROJECT-BODY-CONTENT ".repeat(3000); // ~44K chars
    await writeFile(
      join(testDir, ".fusion", "memory", "MEMORY.md"),
      `# Project Memory\n\n## Architecture\n\n${body}\n\n## Conventions\n\n${body}`,
      "utf-8",
    );

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      includeProjectMemory: true,
      memoryCapChars: 4000,
    });

    expect(prompt).toContain("## Project Memory Index (use fn_memory_search / fn_memory_get to read)");
    expect(prompt).toContain('"Architecture"');
    expect(prompt).toContain('"Conventions"');
    expect(prompt).not.toContain("SECRET-PROJECT-BODY-CONTENT");
    // The whole project-memory block (index + note) must stay near the cap.
    const blockStart = prompt.indexOf("## Project Memory");
    const blockEnd = prompt.indexOf("_Project memory exceeds");
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(blockEnd - blockStart).toBeLessThan(8000);
  });

  it("keeps small project memory fully inlined when memoryCapChars is set", async () => {
    await mkdir(join(testDir, ".fusion", "memory"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "memory", "MEMORY.md"),
      "Project preference: avoid force pushes.",
      "utf-8",
    );

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      includeProjectMemory: true,
      memoryCapChars: 8000,
    });

    expect(prompt).toContain("## Project Memory\n\nProject preference: avoid force pushes.");
    expect(prompt).not.toContain("Project Memory Index");
  });

  it("keeps full project memory injection when no cap is set (engine lanes)", async () => {
    await mkdir(join(testDir, ".fusion", "memory"), { recursive: true });
    const body = "SECRET-PROJECT-BODY-CONTENT ".repeat(3000);
    await writeFile(
      join(testDir, ".fusion", "memory", "MEMORY.md"),
      `# Project Memory\n\n## Architecture\n\n${body}`,
      "utf-8",
    );

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      includeProjectMemory: true,
    });

    expect(prompt).toContain("SECRET-PROJECT-BODY-CONTENT");
    expect(prompt).not.toContain("Project Memory Index");
  });

  it("demotes oversized agent workspace memory to a bounded index when memoryCapChars is set", async () => {
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    const body = "SECRET-AGENT-BODY-CONTENT ".repeat(3000); // ~40K chars
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"),
      `# Agent Memory\n\n## Habits\n\n${body}\n\n## Preferences\n\n${body}`,
      "utf-8",
    );

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      memoryCapChars: 4000,
    });

    expect(prompt).toContain("exceeds this session's 4000-char context budget");
    expect(prompt).toContain("## Agent Memory Index (use fn_memory_search / fn_memory_get to read)");
    expect(prompt).toContain('"Habits"');
    expect(prompt).not.toContain("SECRET-AGENT-BODY-CONTENT");
  });

  /*
  FNXC:ChatContextBudget 2026-09-16-12:40:
  Review finding: the inline-memory demote branch compared bytes but sliced code units. A
  multibyte inline memory must be clamped BY BYTES (shared clampUtf8) — the old slice kept 3x
  the intended bytes for CJK content.
  */
  it("clamps multibyte inline agent memory by bytes in the demote branch", async () => {
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery", memory: "記".repeat(4000) }), // 12000 bytes, 4000 chars
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      memoryCapChars: 1000,
    });
    expect(prompt).toContain("…");
    expect(prompt).not.toContain("記".repeat(2000));
    const match = prompt.match(/記+/);
    const clamped = match ? match[0] : "";
    expect(clamped.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(1000);
    expect(clamped).not.toContain("\uFFFD"); // no split multi-byte characters
  });
  it("keeps agent memory fully inlined when the combined size fits the cap", async () => {
    await mkdir(join(testDir, ".fusion", "agent-memory", "agent-test"), { recursive: true });
    await writeFile(
      join(testDir, ".fusion", "agent-memory", "agent-test", "MEMORY.md"),
      "Workspace habit: run the gate before merge.",
      "utf-8",
    );

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({
        name: "Avery",
        memory: "Inline preference: prefer small diffs.",
      }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      memoryCapChars: 8000,
    });

    expect(prompt).toContain("Inline preference: prefer small diffs.");
    expect(prompt).toContain("Workspace habit: run the gate before merge.");
    expect(prompt).not.toContain("context budget");
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

  /*
  FNXC:MemoryInlineClamp 2026-10-29-13:05 (RUFU-443):
  Oversized memory now warns twice by design: the pre-clamp truncation warn (which still feeds the
  emptiness guard, branch selection, and the bounded-index branch) plus the newest-kept clamp warn that
  names what the agent-visible render actually dropped. This fixture is a uniform "m" blob, so its head
  and tail slices are byte-identical and the retained-content assertion carries the same meaning it
  always did — it is not weakened. The new assertion pins that the loss is now ALSO visible in the
  prompt, which is exactly what was missing before.
  */
  it("logs the truncation warn and the newest-kept clamp warn when oversized memory is clamped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = "m".repeat(50_010);
    const agent = makeAgent({ memory });

    const result = await resolveAgentInstructions(agent, testDir);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("memory exceeded max length");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("agent-instructions");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("memory newest-kept clamp");
    expect(warnSpy.mock.calls[1]?.[0]).toContain("omitted 0/0 sections (10 chars)");
    expect(result).toContain("## Agent Memory");
    expect(result).toContain(memory.slice(0, 50_000));
    expect(result).toContain("kept the newest 50000 of 50010 chars within the 50000-char inline memory budget");
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

/*
FNXC:PerTurnMemoryRecall 2026-08-19-01:05:
RUFU-120 (B.2 LCM phase 2) symptom verification for the CHAT prompt seam (buildAgentChatPrompt):
the dashboard chat manager rebuilds this prompt before EVERY turn's LLM call, so the first
prompt of a chat whose topic matches memory content MUST carry a deduped recall cue (marker +
top-K hit paths), a second call in the same session MUST NOT re-inject it, and every silent
skip (feature off, memory off, no topic, search reject) must leave the prompt unchanged
without throwing. Fake backends use UNIQUE type names (perturn-chat-fake, perturn-chat-fake-reject)
to avoid cross-file registry pollution; no real Stash/qmd process is spawned.
*/
describe("buildAgentChatPrompt per-turn memory recall (RUFU-120 B.2)", () => {
  let testDir: string;
  let fakeHits: MemorySearchResult[];
  let searchCalls: Array<{ query: string; limit?: number }>;
  // RUFU-172: per-query routing so a focus can be answered differently from the project query.
  let fakeSearch: ((query: string, limit?: number) => MemorySearchResult[]) | null = null;

  beforeAll(() => {
    const baseCapabilities = {
      readable: true,
      writable: false,
      supportsAtomicWrite: false,
      hasConflictResolution: false,
      persistent: false,
    };
    const read: NonNullable<Parameters<typeof registerMemoryBackend>[0]["read"]> = async () => ({
      content: "",
      exists: false,
      backend: "perturn-chat-fake",
    });
    const write = async (): Promise<never> => {
      throw new Error("read-only fake");
    };

    registerMemoryBackend({
      type: "perturn-chat-fake",
      name: "Per-turn chat recall fake backend",
      capabilities: baseCapabilities,
      read,
      write,
      search: async (_rootDir, opts) => {
        searchCalls.push(opts);
        if (fakeSearch) return fakeSearch(opts.query, opts.limit);
        return fakeHits;
      },
    });
    registerMemoryBackend({
      type: "perturn-chat-fake-reject",
      name: "Per-turn chat recall fake backend (rejecting search)",
      capabilities: baseCapabilities,
      read,
      write,
      search: async (): Promise<never> => {
        throw new Error("backend search exploded");
      },
    });
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-chat-recall-"));
    fakeHits = [
      { path: ".fusion/memory/MEMORY.md", lineStart: 10, lineEnd: 14, snippet: "B.1 compaction gate landed; B.2 per-turn recall is next.", score: 7, backend: "perturn-chat-fake" },
      { path: ".fusion/memory/2026-08-18.md", lineStart: 3, lineEnd: 6, snippet: "Discussed LCM B.2 priority: per-turn recall with topK=3.", score: 5, backend: "perturn-chat-fake" },
      { path: "notes/lcm.md", lineStart: 1, lineEnd: 3, snippet: "LCM B.1 and B.2 phases from volt-lcm-analysis.md.", score: 3, backend: "perturn-chat-fake" },
      { path: ".fusion/memory/2026-08-15.md", lineStart: 20, lineEnd: 22, snippet: "Merge gate flake quarantine entry.", score: 0, backend: "perturn-chat-fake" },
    ];
    searchCalls = [];
    fakeSearch = null;
    __resetPerTurnRecallDedupForTests();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRecallSettings(overrides: Partial<Settings> = {}): Partial<Settings> {
    return {
      memoryEnabled: true,
      memoryBackendType: "perturn-chat-fake",
      memoryPerTurnRecallEnabled: true,
      memoryPerTurnRecallTopK: 3,
      ...overrides,
    };
  }

  it("(a) first-turn prompt contains the deduped recall cue (marker + top-K hit paths) for the topic", async () => {
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-a", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s1",
      settings: makeRecallSettings(),
    });

    // The cue reuses the pre-steering marker so the model recognizes it.
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain(MEMORY_PRE_STEERING_MARKER);
    // Top-K (3) positive-score hits, ranked by score descending.
    expect(prompt).toContain(".fusion/memory/MEMORY.md");
    expect(prompt).toContain(".fusion/memory/2026-08-18.md");
    expect(prompt).toContain("notes/lcm.md");
    // Zero-score hit is filtered out (client-side score filter).
    expect(prompt).not.toContain(".fusion/memory/2026-08-15.md");
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0].query).toContain("merge");
  });

  it("(b) second call with the same sessionId + topic does NOT re-inject the cue (dedup)", async () => {
    const agent = makeAgent({ id: "agent-recall-b", name: "Recall", role: "engineer" });
    const opts = {
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s1",
      settings: makeRecallSettings(),
    };

    const first = await buildAgentChatPrompt({ agent, ...opts });
    expect(first).toContain("## Memory Recall");

    const second = await buildAgentChatPrompt({ agent, ...opts });
    expect(second).not.toContain("## Memory Recall");
    // The base prompt and identity still build fine without the cue.
    expect(second).toContain("You are a chat assistant.");
  });

  it("(c) a fresh sessionId re-injects the cue (dedup is session-scoped)", async () => {
    const agent = makeAgent({ id: "agent-recall-c", name: "Recall", role: "engineer" });
    const opts = {
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      settings: makeRecallSettings(),
    };

    const first = await buildAgentChatPrompt({ agent, ...opts, sessionId: "s1" });
    expect(first).toContain("## Memory Recall");

    const other = await buildAgentChatPrompt({ agent, ...opts, sessionId: "s2" });
    expect(other).toContain("## Memory Recall");
  });

  it("(d) no topic → no cue AND the backend search is not called", async () => {
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-d", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      settings: makeRecallSettings(),
    });

    expect(prompt).not.toContain("## Memory Recall");
    expect(searchCalls.length).toBe(0);
  });

  it("(e) memoryPerTurnRecallEnabled: false → no cue", async () => {
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-e", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s1",
      settings: makeRecallSettings({ memoryPerTurnRecallEnabled: false }),
    });

    expect(prompt).not.toContain("## Memory Recall");
  });

  it("(f) inclusionMode: 'off' → no cue despite a topic", async () => {
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-f", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s1",
      inclusionMode: "off",
      settings: makeRecallSettings(),
    });

    expect(prompt).not.toContain("## Memory Recall");
  });

  it("(g) fake search rejects → prompt still builds, no throw", async () => {
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-g", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s1",
      settings: makeRecallSettings({ memoryBackendType: "perturn-chat-fake-reject" }),
    });

    expect(prompt).toContain("You are a chat assistant.");
    expect(prompt).toContain("## Identity");
    expect(prompt).not.toContain("## Memory Recall");
  });

  /*
  FNXC:RUFU172ChatFocusLane 2026-08-31-19:41:
  RUFU-172 chat-lane threading: buildAgentChatPrompt forwards a focus to the core two-lane
  recall. With a focus the core issues a SECOND (lane T) search and leads the cue with it;
  with no focus it stays on the single whole-project search. This proves the focus reaches
  the PROACTIVE cue, not just the fn_memory_search tool schema.

  FNXC:MemoryFocusRecall 2026-09-03-00:21:
  RUFU-173 — lane T's query is the focus's content terms OR-joined (three focus words here
  reach the backend as "merge-gate OR remediation OR ledger"), not the raw focus phrase.
  */
  it("(h) forwards a focus: a second lane-T search with the OR-joined focus terms leads the cue", async () => {
    fakeSearch = (query) =>
      query === "merge-gate OR remediation OR ledger"
        ? [{ path: "notes/focus-ledger.md", lineStart: 2, lineEnd: 5, snippet: "Focus ledger merge-gate remediation.", score: 9, backend: "perturn-chat-fake" }]
        : fakeHits;
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-h", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s-h",
      settings: makeRecallSettings(),
      focus: "merge-gate remediation ledger",
    });

    // Two searches: lane P (keywords) then lane T (OR-joined focus terms).
    expect(searchCalls.length).toBe(2);
    expect(searchCalls[0].query).toContain("merge");
    expect(searchCalls[1].query).toBe("merge-gate OR remediation OR ledger");
    // Focus hit leads the cue (topic-first ordering) alongside the project cue.
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("notes/focus-ledger.md");
  });

  it("(i) no focus → exactly one whole-project search, no lane-T query is ever issued", async () => {
    fakeSearch = (query) => (query === "some focus" ? [{ path: "t.md", lineStart: 1, lineEnd: 2, snippet: "topic", score: 9, backend: "perturn-chat-fake" }] : fakeHits);
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ id: "agent-recall-i", name: "Recall", role: "engineer" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      topic: "merge gate flake",
      sessionId: "s-i",
      settings: makeRecallSettings(),
      // focus omitted entirely
    });

    // One search only; the cue is the whole-project form and never references the focus hit.
    expect(searchCalls.length).toBe(1);
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).not.toContain("notes/focus-ledger.md");
    expect(prompt).not.toContain("t.md");
  });
});

/*
 * FNXC:MemoryInlineClamp 2026-10-29-13:15 (RUFU-443):
 * The inline memory clamp used to return the HEAD of the file, so every `fn_memory_append` — which
 * writes at the END — pushed its own lesson out of the prompt. Measured on a production
 * `.fusion/agent-memory/agent-6774b4e6/MEMORY.md` (365,204 chars): 174 of 205 sections (85%) never
 * arrived, the cut landed mid-sentence, and nothing in the prompt said the rest existed. Every case
 * below asserts on the RENDERED output of the two observable entry points
 * (`resolveAgentInstructions` full mode, `buildAgentChatPrompt` capped path), never on an internal
 * constant; `MAX_MEMORY_LENGTH` is imported only to size fixtures and to bound-check rendered output.
 */

/** Zero-padded so entry N's sentinel is never a substring of another entry's sentinel. */
function padEntry(index: number): string {
  return String(index).padStart(3, "0");
}

/**
 * A memory file shaped like the production ones: preamble, then `sectionCount` distinct `## `
 * entries of > 260 chars each (real boundaries for the section-suffix clamp to respect) totaling
 * above the inline budget, with zero exact duplicates and a unique sentinel on the newest entry.
 * ~313 chars/section × 220 sections ≈ 69K chars — just over budget, far below a production megabyte
 * (FN-5048: no slow fixtures).
 */
function sectionedMemory(
  sectionCount: number,
  options: { newestSentinel?: string; prefix?: string } = {},
): string {
  const prefix = options.prefix ?? "OLD-SENTINEL";
  const filler = "filler ".repeat(40);
  let out = "# Agent Memory\n\n<!-- durable notes below -->\n\n";
  for (let i = 1; i <= sectionCount; i += 1) {
    const sentinel =
      i === sectionCount ? (options.newestSentinel ?? "NEWEST-SENTINEL") : `${prefix}-${padEntry(i)}`;
    out += `## Lesson ${padEntry(i)}\n\n${sentinel} ${filler}\n`;
  }
  return out;
}

const WORKSPACE_CLAMP_NOTICE =
  /_Workspace memory: kept the newest (\d+) of (\d+) chars within the (\d+)-char inline memory budget, so (\d+) of (\d+) older sections \((\d+) chars\) are NOT in this prompt/;
const INLINE_CLAMP_NOTICE =
  /_Inline agent memory: kept the newest (\d+) of (\d+) chars within the (\d+)-char inline memory budget, so (\d+) of (\d+) older sections \((\d+) chars\) are NOT in this prompt/;
const BLOB_CLAMP_NOTICE =
  /_(?:Workspace memory|Inline agent memory): kept the newest (\d+) of (\d+) chars within the (\d+)-char inline memory budget, so (\d+) chars of heading-less text are NOT in this prompt/;

/** How many of a fixture's sections actually reached the rendered prompt (newest entry included). */
function presentSentinelCount(
  rendered: string,
  sectionCount: number,
  options: { prefix?: string; newestSentinel?: string } = {},
): number {
  const prefix = options.prefix ?? "OLD-SENTINEL";
  const newest = options.newestSentinel ?? "NEWEST-SENTINEL";
  let present = 0;
  for (let i = 1; i <= sectionCount; i += 1) {
    const sentinel = i === sectionCount ? newest : `${prefix}-${padEntry(i)}`;
    if (rendered.includes(sentinel)) present += 1;
  }
  return present;
}

async function writeWorkspaceMemory(rootDir: string, content: string, agentId = "agent-test"): Promise<void> {
  await mkdir(join(rootDir, ".fusion", "agent-memory", agentId), { recursive: true });
  await writeFile(join(rootDir, ".fusion", "agent-memory", agentId, "MEMORY.md"), content, "utf-8");
}

describe("inline long-term memory clamp keeps the newest entries (RUFU-443)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-instr-clamp-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("keeps the newest workspace sections and announces the omitted range in full mode", async () => {
    const sections = 220;
    const memory = sectionedMemory(sections);
    expect(memory.length).toBeGreaterThan(MAX_MEMORY_LENGTH);
    await writeWorkspaceMemory(testDir, memory);

    const result = await resolveAgentInstructions(makeAgent({ memory: "" }), testDir);
    const notice = result.match(WORKSPACE_CLAMP_NOTICE);
    expect(notice).not.toBeNull();
    const [, keptChars, totalChars, budget, omittedSections, totalSections, omittedChars] = notice!;

    // The symptom: the freshest lesson used to be exactly what got cut.
    expect(result).toContain("NEWEST-SENTINEL");
    expect(result).not.toContain("OLD-SENTINEL-001");
    expect(result).toContain("<!-- durable notes below -->"); // preamble survives with the newest suffix

    // The notice must agree with what the prompt actually contains, section by section and char by char.
    expect(Number(budget)).toBe(MAX_MEMORY_LENGTH);
    expect(Number(totalChars)).toBe(memory.trim().length);
    expect(Number(totalSections)).toBe(sections);
    const present = presentSentinelCount(result, sections);
    expect(present).toBeGreaterThan(0);
    expect(present).toBeLessThan(sections);
    expect(Number(omittedSections)).toBe(sections - present);

    // The rendered body is the last thing in the collapsed output, so its real length is measurable
    // (the notice line is matched by a prefix scan because the regex above covers only its first half).
    const noticeLine = result.split("\n").find((line) => line.startsWith("_Workspace memory:")) ?? "";
    const rendered = result.slice(result.indexOf(noticeLine) + noticeLine.length + 2);
    expect(rendered.length).toBeLessThanOrEqual(MAX_MEMORY_LENGTH);
    expect(Number(omittedChars)).toBe(memory.trim().length - rendered.length);
    // The headline number is the REAL retained length, not the budget: a kept section suffix stops
    // short of `maxLength` whenever the next-oldest section does not fit whole.
    expect(Number(keptChars)).toBe(rendered.length);
    expect(Number(keptChars)).toBeLessThanOrEqual(MAX_MEMORY_LENGTH);
  });

  it("keeps the newest entries of an oversized inline agent.memory", async () => {
    const sections = 220;
    const memory = sectionedMemory(sections, { prefix: "OLD-INLINE" });

    const result = await resolveAgentInstructions(makeAgent({ memory }), testDir);
    const notice = result.match(INLINE_CLAMP_NOTICE);
    expect(notice).not.toBeNull();

    expect(result).toContain("NEWEST-SENTINEL");
    expect(result).not.toContain("OLD-INLINE-001");
    expect(Number(notice![2])).toBe(memory.trim().length);
    expect(Number(notice![4])).toBe(sections - presentSentinelCount(result, sections, { prefix: "OLD-INLINE" }));
  });

  it("keeps the newest entries and announces the loss for both inputs oversized at once", async () => {
    const sections = 220;
    await writeWorkspaceMemory(testDir, sectionedMemory(sections, { newestSentinel: "NEWEST-WORKSPACE" }));

    const result = await resolveAgentInstructions(
      makeAgent({ memory: sectionedMemory(sections, { newestSentinel: "NEWEST-INLINE", prefix: "OLD-INLINE" }) }),
      testDir,
    );

    expect(result).toContain("NEWEST-INLINE");
    expect(result).toContain("NEWEST-WORKSPACE");
    expect(result).toContain("### Long-term Workspace Memory");
    expect(result).not.toContain("OLD-INLINE-001");
    expect(result).not.toContain("OLD-SENTINEL-001");
    expect(result.match(INLINE_CLAMP_NOTICE)).not.toBeNull();
    expect(result.match(WORKSPACE_CLAMP_NOTICE)).not.toBeNull();
  });

  it("keeps the newest entries on the chat path when a cap is set but does not bite (full-render fall-through)", async () => {
    const sections = 220;
    const memory = sectionedMemory(sections);
    await writeWorkspaceMemory(testDir, memory);

    // Cap above the combined (pre-clamped) size, so the bounded-index branch is NOT selected and the
    // full render is reached with a > 50K source — the shape that used to be silently head-sliced.
    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery", memory: "" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      memoryCapChars: 60_000,
    });

    expect(prompt).not.toContain("exceeds this session's 60000-char context budget");
    expect(prompt).toContain("NEWEST-SENTINEL");
    expect(prompt).not.toContain("OLD-SENTINEL-001");
    const notice = prompt.match(WORKSPACE_CLAMP_NOTICE);
    expect(notice).not.toBeNull();
    expect(Number(notice![2])).toBe(memory.trim().length);
    expect(Number(notice![4])).toBe(sections - presentSentinelCount(prompt, sections));
  });

  /*
   * FNXC:MemoryInlineClamp 2026-10-29-13:15 (RUFU-443) — the PR1 scope decision, pinned:
   * the `memoryCapChars` bounded-index branch deliberately keeps its head-slice pre-clamp (it already
   * self-announces through its own budget notice, and re-pointing it would rewrite the heading
   * contract its own tests assert). This case names the accepted residual — the index enumerates
   * oldest-first headings only — so the deferred contract is visible rather than implied.
   */
  it("leaves the bounded-index branch's oldest-first heading index unchanged (deferred contract)", async () => {
    const sections = 220;
    await writeWorkspaceMemory(testDir, sectionedMemory(sections));

    const prompt = await buildAgentChatPrompt({
      agent: makeAgent({ name: "Avery", memory: "" }),
      rootDir: testDir,
      basePrompt: "You are a chat assistant.",
      memoryCapChars: 4_000,
    });

    expect(prompt).toContain("exceeds this session's 4000-char context budget");
    expect(prompt).toContain("## Agent Memory Index (use fn_memory_search / fn_memory_get to read)");
    expect(prompt).toContain('"Lesson 001"'); // oldest-first, from the head-slice pre-clamp
    expect(prompt).not.toContain('"Lesson 220"'); // beyond the pre-clamp, as before RUFU-443
    expect(prompt).not.toContain("NEWEST-SENTINEL");
    expect(prompt).not.toContain("inline memory budget"); // the full-render notice is not this branch's
  });

  it("renders under-budget memory verbatim with no notice", async () => {
    const memory = sectionedMemory(4);
    expect(memory.length).toBeLessThan(MAX_MEMORY_LENGTH);
    await writeWorkspaceMemory(testDir, memory);

    const result = await resolveAgentInstructions(makeAgent({ memory: "" }), testDir);

    expect(result).toContain(memory.trim());
    expect(result).toContain("Lesson 004");
    expect(result).not.toContain("inline memory budget");
    expect(result).not.toContain("are NOT in this prompt");
  });

  it("keeps the tail of a heading-less oversized blob and announces the dropped head", async () => {
    const blob = `HEAD-MARKER ${"z".repeat(MAX_MEMORY_LENGTH)} TAIL-MARKER`;
    await writeWorkspaceMemory(testDir, blob);

    const result = await resolveAgentInstructions(makeAgent({ memory: "" }), testDir);

    expect(result).toContain("TAIL-MARKER");
    expect(result.endsWith("TAIL-MARKER")).toBe(true);
    expect(result).not.toContain("HEAD-MARKER");
    expect(result.match(BLOB_CLAMP_NOTICE)).not.toBeNull();
  });

  it("does not dedupe duplicated sections while clamping (consolidation is RUFU-279's lane)", async () => {
    const duplicate = "## Repeat Lesson\n\nDUP-SENTINEL filler filler\n";
    const memory = `${sectionedMemory(200)}${duplicate.repeat(3)}${duplicate.slice(0, -1)}`;
    await writeWorkspaceMemory(testDir, memory);

    const result = await resolveAgentInstructions(makeAgent({ memory: "" }), testDir);

    expect((result.match(/DUP-SENTINEL/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((result.match(/## Repeat Lesson/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("clamps multi-byte content on code-point boundaries", async () => {
    // BMP content: the inline budget is char-counted (see `FNXC:ChatContextBudget 2026-09-16-12:40`
    // for the byte/char disagreement this convention deliberately does NOT re-open).
    const bmpResult = await resolveAgentInstructions(
      makeAgent({ memory: "記".repeat(MAX_MEMORY_LENGTH + 10_000) }),
      testDir,
    );
    const bmpRun = bmpResult.match(/記+/)?.[0] ?? "";
    expect(bmpRun.length).toBeGreaterThan(MAX_MEMORY_LENGTH - 50);
    expect(bmpRun.length).toBeLessThanOrEqual(MAX_MEMORY_LENGTH);
    expect(bmpResult).not.toContain("\uFFFD");

    // Astral content: the tail cut lands mid surrogate pair, which must never render U+FFFD.
    const surrogateMemory = `${"😀".repeat(30_000)}TAIL-M`;
    const emojiResult = await resolveAgentInstructions(makeAgent({ memory: surrogateMemory }), testDir);
    expect(emojiResult).not.toContain("\uFFFD");
    expect(emojiResult.endsWith("TAIL-M")).toBe(true);
    expect((emojiResult.match(/😀+/)?.[0] ?? "").length * 2).toBeLessThanOrEqual(MAX_MEMORY_LENGTH * 2);
  });

  it("is deterministic for the same input (prompt-cache stability)", async () => {
    await writeWorkspaceMemory(testDir, sectionedMemory(220));
    const agent = makeAgent({ memory: sectionedMemory(60, { prefix: "OLD-INLINE" }) });

    const first = await resolveAgentInstructions(agent, testDir);
    const second = await resolveAgentInstructions(agent, testDir);

    expect(second).toBe(first);
  });

  it("still honors inclusionMode off and index over the new clamp", async () => {
    await writeWorkspaceMemory(testDir, sectionedMemory(220));
    const agent = makeAgent({ memory: "" });

    expect(await resolveAgentInstructions(agent, testDir, undefined, "off")).toBe("");

    const indexMode = await resolveAgentInstructions(agent, testDir, undefined, "index");
    expect(indexMode).toContain("index mode");
    expect(indexMode).not.toContain("NEWEST-SENTINEL");
    expect(indexMode).not.toContain("inline memory budget");
  });
});
