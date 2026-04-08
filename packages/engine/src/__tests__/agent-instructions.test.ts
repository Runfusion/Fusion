import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent } from "@fusion/core";
import { resolveAgentInstructions, buildSystemPromptWithInstructions } from "../agent-instructions.js";

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
