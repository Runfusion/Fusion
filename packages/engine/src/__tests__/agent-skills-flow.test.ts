/**
 * Integration-style tests for agent skills flow.
 *
 * Tests the full metadata → engine flow using mocked AgentStore and in-memory filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionSkillContext } from "../session-skill-context.js";
import { resolveSessionSkills, createSkillsOverrideFromSelection } from "../skill-resolver.js";
import type { Agent, AgentStore } from "@fusion/core";

// ── Mock Setup ───────────────────────────────────────────────────────────────

// In-memory file system for tests - using a module-scoped Map
const mockFiles = new Map<string, string>();
let mockDirCounter = 0;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: unknown) => mockFiles.has(String(path)),
    readFileSync: (path: unknown) => mockFiles.get(String(path)) ?? "{}",
    mkdtempSync: () => `/tmp/agent-skills-flow-mock-${++mockDirCounter}`,
    writeFileSync: (path: unknown, content: unknown) => mockFiles.set(String(path), String(content)),
    rmSync: (path: unknown) => {
      const pathStr = String(path);
      for (const key of mockFiles.keys()) {
        if (key.startsWith(pathStr)) mockFiles.delete(key);
      }
    },
  };
});

// ── Test Helpers ─────────────────────────────────────────────────────────────

function createMockProjectDir(settings: Record<string, unknown> | null): string {
  const dir = `/tmp/agent-skills-flow-mock-${++mockDirCounter}`;
  if (settings !== null) {
    mockFiles.set(`${dir}/.fusion/settings.json`, JSON.stringify(settings));
  }
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("agent skills flow - full integration", () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    mockFiles.clear();
    mockDirCounter = 0;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("full end-to-end flow: settings patterns + agent metadata + discovered skills produce correct override", async () => {
    // Step 1: Set up mock filesystem with settings that include review but exclude lint
    const projectRootDir = createMockProjectDir({
      skills: ["+skills/review/SKILL.md", "+skills/lint/SKILL.md", "-skills/lint/SKILL.md"],
    });

    // Step 2: Create mock AgentStore with agent that has review skill
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "idle",
      metadata: { skills: ["review"] },
    } as unknown as Agent;

    const mockAgentStore = {
      getAgent: vi.fn().mockResolvedValue(mockAgent),
    } as unknown as AgentStore;

    // Step 3: Create task with assigned agent
    const task = { assignedAgentId: "agent-001" };

    // Step 4: Build session skill context from agent metadata
    const sessionResult = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task,
      sessionPurpose: "executor",
      projectRootDir,
    });

    // Verify skill source and resolved names
    expect(sessionResult.skillSource).toBe("assigned-agent");
    expect(sessionResult.resolvedSkillNames).toEqual(["review"]);
    expect(sessionResult.skillSelectionContext).toBeDefined();
    expect(sessionResult.skillSelectionContext?.requestedSkillNames).toEqual(["review"]);

    // Step 5: Resolve session skills from project settings
    const resolvedSkills = resolveSessionSkills(sessionResult.skillSelectionContext!);

    // Verify the settings-based resolution
    expect(resolvedSkills.filterActive).toBe(true);
    expect(resolvedSkills.allowedSkillPaths.has("skills/review/SKILL.md")).toBe(true);
    // lint should NOT be in allowed paths (it was explicitly excluded)
    expect(resolvedSkills.allowedSkillPaths.has("skills/lint/SKILL.md")).toBe(false);
    // lint should be in excluded paths
    expect(resolvedSkills.excludedSkillPaths.has("skills/lint/SKILL.md")).toBe(true);

    // Step 6: Create override callback from selection
    const override = createSkillsOverrideFromSelection(resolvedSkills, {
      sessionPurpose: "executor",
    });

    // Step 7: Apply override to discovered skills (both review and lint exist)
    const base = {
      skills: [
        { name: "review", filePath: "skills/review/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        { name: "lint", filePath: "skills/lint/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
      ],
      diagnostics: [],
    };

    const overrideResult = override(base);

    // Step 8: Verify only review passes through (lint is disabled)
    expect(overrideResult.skills).toHaveLength(1);
    expect(overrideResult.skills[0].name).toBe("review");

    // Step 9: Verify warning diagnostic for disabled lint skill
    const disabledLintWarning = overrideResult.diagnostics.find(d =>
      d.message.includes("disabled") && d.message.includes("lint")
    );
    expect(disabledLintWarning).toBeDefined();
    expect(disabledLintWarning?.type).toBe("warning");

    // Step 10: Verify console.error was called with disabled skill warning
    const loggedMessages = consoleErrorSpy.mock.calls.map(c => c[0] as string);
    const hasDisabledLintWarning = loggedMessages.some(m =>
      m.includes("disabled") && m.includes("lint")
    );
    expect(hasDisabledLintWarning).toBe(true);
  });

  it("flow with no exclusion pattern - both review and lint requested", async () => {
    // Step 1: Set up mock filesystem with settings that include both skills
    const projectRootDir = createMockProjectDir({
      skills: ["+skills/review/SKILL.md", "+skills/lint/SKILL.md"],
    });

    // Step 2: Create mock AgentStore with agent that has BOTH review and lint skills
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "idle",
      metadata: { skills: ["review", "lint"] },
    } as unknown as Agent;

    const mockAgentStore = {
      getAgent: vi.fn().mockResolvedValue(mockAgent),
    } as unknown as AgentStore;

    // Step 3: Build session skill context
    const sessionResult = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: { assignedAgentId: "agent-001" },
      sessionPurpose: "executor",
      projectRootDir,
    });

    expect(sessionResult.skillSource).toBe("assigned-agent");
    expect(sessionResult.resolvedSkillNames).toEqual(["review", "lint"]);

    // Step 4: Resolve session skills from settings
    const resolvedSkills = resolveSessionSkills(sessionResult.skillSelectionContext!);

    expect(resolvedSkills.filterActive).toBe(true);
    expect(resolvedSkills.allowedSkillPaths.has("skills/review/SKILL.md")).toBe(true);
    expect(resolvedSkills.allowedSkillPaths.has("skills/lint/SKILL.md")).toBe(true);
    expect(resolvedSkills.excludedSkillPaths.size).toBe(0);

    // Step 5: Create override and apply to discovered skills
    const override = createSkillsOverrideFromSelection(resolvedSkills, {
      sessionPurpose: "executor",
    });

    const base = {
      skills: [
        { name: "review", filePath: "skills/review/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
        { name: "lint", filePath: "skills/lint/SKILL.md", description: "", baseDir: "", sourceInfo: {} as any, disableModelInvocation: false },
      ],
      diagnostics: [],
    };

    const overrideResult = override(base);

    // When both skills are requested, both should pass through
    expect(overrideResult.skills).toHaveLength(2);
    expect(overrideResult.skills.map(s => s.name)).toEqual(["review", "lint"]);

    // No disabled warnings since neither skill was excluded
    const disabledWarnings = overrideResult.diagnostics.filter(d =>
      d.message.includes("disabled")
    );
    expect(disabledWarnings).toHaveLength(0);
  });

  it("flow with role fallback when assigned agent has no skills", async () => {
    // Step 1: Set up mock filesystem
    const projectRootDir = createMockProjectDir({
      skills: ["+skills/executor/SKILL.md"],
    });

    // Step 2: Create mock AgentStore with agent that has NO skills
    const mockAgent: Agent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "idle",
      metadata: { skills: [] },
    } as unknown as Agent;

    const mockAgentStore = {
      getAgent: vi.fn().mockResolvedValue(mockAgent),
    } as unknown as AgentStore;

    // Step 3: Build session skill context - should fall back to role
    const sessionResult = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: { assignedAgentId: "agent-001" },
      sessionPurpose: "executor",
      projectRootDir,
    });

    // Verify role fallback
    expect(sessionResult.skillSource).toBe("role-fallback");
    expect(sessionResult.resolvedSkillNames).toEqual(["executor"]);
    expect(sessionResult.skillSelectionContext?.requestedSkillNames).toEqual(["executor"]);

    // Step 4: Resolve session skills from settings
    const resolvedSkills = resolveSessionSkills(sessionResult.skillSelectionContext!);

    expect(resolvedSkills.filterActive).toBe(true);
    expect(resolvedSkills.allowedSkillPaths.has("skills/executor/SKILL.md")).toBe(true);
  });
});
