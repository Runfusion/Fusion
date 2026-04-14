import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeAgentSkills,
  buildSessionSkillContext,
  buildSessionSkillContextSync,
  SKILL_DIAGNOSTIC_MESSAGES,
  type SessionPurpose,
} from "./session-skill-context.js";
import type { Agent } from "@fusion/core";
import type { AgentStore } from "@fusion/core";

describe("normalizeAgentSkills", () => {
  it("returns empty array for non-array input", () => {
    expect(normalizeAgentSkills(undefined)).toEqual([]);
    expect(normalizeAgentSkills(null)).toEqual([]);
    expect(normalizeAgentSkills("string")).toEqual([]);
    expect(normalizeAgentSkills({})).toEqual([]);
  });

  it("handles string entries", () => {
    const skills = ["triage", "executor", "reviewer"];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor", "reviewer"]);
  });

  it("handles object entries with name property", () => {
    const skills = [
      { name: "triage" },
      { name: "executor" },
      { name: "reviewer" },
    ];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor", "reviewer"]);
  });

  it("handles mixed string and object entries", () => {
    const skills = [
      "triage",
      { name: "executor" },
      { name: "reviewer" },
      "merger",
    ];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor", "reviewer", "merger"]);
  });

  it("trims whitespace from entries", () => {
    const skills = ["  triage  ", { name: "  executor  " }];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor"]);
  });

  it("drops empty entries", () => {
    const skills = ["", "triage", "   ", "executor", { name: "" }, { name: "reviewer" }];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor", "reviewer"]);
  });

  it("drops invalid entries", () => {
    const skills = [
      123,
      null,
      { foo: "bar" },
      "triage",
      undefined,
      { name: "executor" },
    ];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor"]);
  });

  it("deduplicates while preserving first occurrence order", () => {
    const skills = ["triage", "executor", "triage", "reviewer", "executor"];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor", "reviewer"]);
  });

  it("handles duplicate object entries", () => {
    const skills = [
      { name: "triage" },
      { name: "executor" },
      { name: "triage" },
    ];
    expect(normalizeAgentSkills(skills)).toEqual(["triage", "executor"]);
  });

  it("handles case-sensitive deduplication", () => {
    const skills = ["Triage", "triage", "EXECUTOR", "executor"];
    expect(normalizeAgentSkills(skills)).toEqual(["Triage", "triage", "EXECUTOR", "executor"]);
  });

  it("returns empty array for array of only invalid entries", () => {
    expect(normalizeAgentSkills([null, undefined, "", 123, {}])).toEqual([]);
  });
});

describe("buildSessionSkillContextSync", () => {
  const projectRootDir = "/test/project";

  describe("assigned agent skills", () => {
    it("uses assigned agent skills when available", () => {
      const agent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
        metadata: { skills: ["triage", "executor"] },
      } as unknown as Agent;

      const result = buildSessionSkillContextSync(agent, "executor", projectRootDir);

      expect(result.skillSource).toBe("assigned-agent");
      expect(result.resolvedSkillNames).toEqual(["triage", "executor"]);
      expect(result.skillSelectionContext).toEqual({
        projectRootDir,
        requestedSkillNames: ["triage", "executor"],
        sessionPurpose: "executor",
      });
    });

    it("uses object-style agent skills", () => {
      const agent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
        metadata: { skills: [{ name: "triage" }, { name: "executor" }] },
      } as unknown as Agent;

      const result = buildSessionSkillContextSync(agent, "executor", projectRootDir);

      expect(result.skillSource).toBe("assigned-agent");
      expect(result.resolvedSkillNames).toEqual(["triage", "executor"]);
    });

    it("falls back to role when agent has empty skills", () => {
      const agent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
        metadata: { skills: [] },
      } as unknown as Agent;

      const result = buildSessionSkillContextSync(agent, "executor", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["executor"]);
    });

    it("falls back to role when agent has no metadata", () => {
      const agent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
        metadata: {},
      } as unknown as Agent;

      const result = buildSessionSkillContextSync(agent, "executor", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["executor"]);
    });

    it("falls back to role when agent has no metadata.skills", () => {
      const agent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
      } as unknown as Agent;

      const result = buildSessionSkillContextSync(agent, "executor", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["executor"]);
    });
  });

  describe("role fallback skills", () => {
    it("returns triage role fallback for triage purpose", () => {
      const result = buildSessionSkillContextSync(null, "triage", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["triage"]);
    });

    it("returns executor role fallback for executor purpose", () => {
      const result = buildSessionSkillContextSync(null, "executor", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["executor"]);
    });

    it("returns reviewer role fallback for reviewer purpose", () => {
      const result = buildSessionSkillContextSync(null, "reviewer", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["reviewer"]);
    });

    it("returns merger role fallback for merger purpose", () => {
      const result = buildSessionSkillContextSync(null, "merger", projectRootDir);

      expect(result.skillSource).toBe("role-fallback");
      expect(result.resolvedSkillNames).toEqual(["merger"]);
    });

    it("returns no skills for heartbeat purpose (no role fallback)", () => {
      const result = buildSessionSkillContextSync(null, "heartbeat", projectRootDir);

      expect(result.skillSource).toBe("none");
      expect(result.resolvedSkillNames).toEqual([]);
      expect(result.skillSelectionContext).toBeUndefined();
    });

    it("uses agent skills over role fallback", () => {
      const agent = {
        id: "agent-001",
        name: "Test Agent",
        role: "executor",
        state: "idle",
        metadata: { skills: ["custom-skill-1", "custom-skill-2"] },
      } as unknown as Agent;

      const result = buildSessionSkillContextSync(agent, "executor", projectRootDir);

      expect(result.skillSource).toBe("assigned-agent");
      expect(result.resolvedSkillNames).toEqual(["custom-skill-1", "custom-skill-2"]);
    });
  });

  describe("no skills available", () => {
    it("returns undefined context when no skills and no fallback", () => {
      const result = buildSessionSkillContextSync(null, "heartbeat", projectRootDir);

      expect(result.skillSelectionContext).toBeUndefined();
      expect(result.resolvedSkillNames).toEqual([]);
    });
  });
});

describe("buildSessionSkillContext", () => {
  const projectRootDir = "/test/project";

  it("uses assigned agent skills when available", async () => {
    const mockAgent = {
      id: "agent-001",
      name: "Test Agent",
      role: "executor",
      state: "idle",
      metadata: { skills: ["triage", "executor"] },
    } as unknown as Agent;

    const mockAgentStore = {
      getAgent: vi.fn().mockResolvedValue(mockAgent),
    } as unknown as AgentStore;

    const result = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: { assignedAgentId: "agent-001" },
      sessionPurpose: "executor",
      projectRootDir,
    });

    expect(result.skillSource).toBe("assigned-agent");
    expect(result.resolvedSkillNames).toEqual(["triage", "executor"]);
    expect(mockAgentStore.getAgent).toHaveBeenCalledWith("agent-001");
  });

  it("falls back to role when no assignedAgentId", async () => {
    const mockAgentStore = {
      getAgent: vi.fn(),
    } as unknown as AgentStore;

    const result = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: {},
      sessionPurpose: "executor",
      projectRootDir,
    });

    expect(result.skillSource).toBe("role-fallback");
    expect(result.resolvedSkillNames).toEqual(["executor"]);
    expect(mockAgentStore.getAgent).not.toHaveBeenCalled();
  });

  it("falls back to role when assigned agent not found", async () => {
    const mockAgentStore = {
      getAgent: vi.fn().mockResolvedValue(null),
    } as unknown as AgentStore;

    const result = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: { assignedAgentId: "nonexistent" },
      sessionPurpose: "triage",
      projectRootDir,
    });

    expect(result.skillSource).toBe("role-fallback");
    expect(result.resolvedSkillNames).toEqual(["triage"]);
  });

  it("falls back to role when agent lookup throws", async () => {
    const mockAgentStore = {
      getAgent: vi.fn().mockRejectedValue(new Error("DB error")),
    } as unknown as AgentStore;

    const result = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: { assignedAgentId: "agent-001" },
      sessionPurpose: "reviewer",
      projectRootDir,
    });

    expect(result.skillSource).toBe("role-fallback");
    expect(result.resolvedSkillNames).toEqual(["reviewer"]);
  });

  it("uses heartbeat with no skills when no assigned agent", async () => {
    const mockAgentStore = {
      getAgent: vi.fn(),
    } as unknown as AgentStore;

    const result = await buildSessionSkillContext({
      agentStore: mockAgentStore,
      task: {},
      sessionPurpose: "heartbeat",
      projectRootDir,
    });

    expect(result.skillSource).toBe("none");
    expect(result.resolvedSkillNames).toEqual([]);
    expect(result.skillSelectionContext).toBeUndefined();
  });
});

describe("SKILL_DIAGNOSTIC_MESSAGES", () => {
  it("provides missing skill message template", () => {
    const msg = SKILL_DIAGNOSTIC_MESSAGES.missing("custom-skill");
    expect(msg).toBe('skill selection: requested skill "custom-skill" not found in discovered skills');
  });

  it("provides filtered skill message template", () => {
    const msg = SKILL_DIAGNOSTIC_MESSAGES.filtered("custom-skill");
    expect(msg).toBe('skill selection: requested skill "custom-skill" filtered out by execution-enabled settings');
  });

  it("provides assigned agent message template", () => {
    const msg = SKILL_DIAGNOSTIC_MESSAGES.assignedAgentSkills(3, "agent-001");
    expect(msg).toBe("Using skills from assigned agent agent-001 (3 skills)");
  });

  it("provides role fallback message template", () => {
    const msg = SKILL_DIAGNOSTIC_MESSAGES.roleFallbackSkills("triage", ["triage"]);
    expect(msg).toBe("Using role fallback skills for triage: [triage]");
  });

  it("provides no skills available message template", () => {
    const msg = SKILL_DIAGNOSTIC_MESSAGES.noSkillsAvailable("heartbeat");
    expect(msg).toBe("No skills available for heartbeat session (no assigned agent, no role fallback)");
  });
});
