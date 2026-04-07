import { describe, it, expect } from "vitest";
import type {
  CompaniesShManifest,
  CompaniesShAgent,
  CompaniesShConfig,
  CompaniesShMetadata,
  CompaniesShEnvVar,
  CompaniesShImportResult,
  CompaniesShRole,
} from "./companies-sh-types.js";

describe("companies-sh-types", () => {
  describe("CompaniesShAgent", () => {
    it("accepts a valid minimal agent with required fields", () => {
      const agent: CompaniesShAgent = {
        name: "Code Reviewer",
        role: "reviewer",
      };
      expect(agent.name).toBe("Code Reviewer");
      expect(agent.role).toBe("reviewer");
    });

    it("accepts a fully populated agent", () => {
      const agent: CompaniesShAgent = {
        name: "Code Reviewer",
        role: "reviewer",
        capabilities: ["code-review", "security-audit"],
        config: {
          model: "claude-sonnet-4",
          maxTokens: 4096,
          thinkingLevel: "medium",
          maxTurns: 10,
        },
        metadata: {
          title: "Senior Code Reviewer",
          icon: "👁",
          description: "Reviews code for quality and security",
        },
      };
      expect(agent.name).toBe("Code Reviewer");
      expect(agent.capabilities).toHaveLength(2);
      expect(agent.config?.model).toBe("claude-sonnet-4");
      expect(agent.metadata?.title).toBe("Senior Code Reviewer");
    });

    it("accepts an agent with optional fields omitted", () => {
      const agent: CompaniesShAgent = {
        name: "Simple Agent",
        role: "executor",
      };
      expect(agent.capabilities).toBeUndefined();
      expect(agent.config).toBeUndefined();
      expect(agent.metadata).toBeUndefined();
    });
  });

  describe("CompaniesShConfig", () => {
    it("accepts a config with all optional fields", () => {
      const config: CompaniesShConfig = {
        model: "provider/model-id",
        maxTokens: 8192,
        thinkingLevel: "high",
        maxTurns: 20,
      };
      expect(config.model).toBe("provider/model-id");
      expect(config.maxTokens).toBe(8192);
    });

    it("accepts an empty config", () => {
      const config: CompaniesShConfig = {};
      expect(config.model).toBeUndefined();
    });
  });

  describe("CompaniesShMetadata", () => {
    it("accepts metadata with all fields", () => {
      const meta: CompaniesShMetadata = {
        title: "Job Title",
        icon: "🤖",
        description: "An AI agent",
      };
      expect(meta.title).toBe("Job Title");
      expect(meta.icon).toBe("🤖");
    });
  });

  describe("CompaniesShManifest", () => {
    it("accepts a valid manifest structure", () => {
      const manifest: CompaniesShManifest = {
        companyName: "my-company",
        agents: [
          { name: "Agent 1", role: "executor" },
          { name: "Agent 2", role: "reviewer" },
        ],
        envVars: [
          { name: "KB_AGENT_MODEL", defaultValue: "claude-sonnet-4" },
        ],
      };
      expect(manifest.companyName).toBe("my-company");
      expect(manifest.agents).toHaveLength(2);
      expect(manifest.envVars).toHaveLength(1);
    });

    it("accepts a manifest with empty agents array", () => {
      const manifest: CompaniesShManifest = {
        companyName: "empty-company",
        agents: [],
        envVars: [],
      };
      expect(manifest.agents).toHaveLength(0);
    });
  });

  describe("CompaniesShEnvVar", () => {
    it("accepts an env var with name and default", () => {
      const envVar: CompaniesShEnvVar = {
        name: "KB_MODEL",
        defaultValue: "claude-sonnet-4",
      };
      expect(envVar.name).toBe("KB_MODEL");
      expect(envVar.defaultValue).toBe("claude-sonnet-4");
    });
  });

  describe("CompaniesShImportResult", () => {
    it("accepts a valid import result", () => {
      const result: CompaniesShImportResult = {
        created: ["agent-1", "agent-2"],
        skipped: ["agent-3"],
        errors: [{ name: "bad-agent", error: "missing role" }],
      };
      expect(result.created).toHaveLength(2);
      expect(result.skipped).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
    });

    it("accepts an empty result", () => {
      const result: CompaniesShImportResult = {
        created: [],
        skipped: [],
        errors: [],
      };
      expect(result.created).toHaveLength(0);
    });
  });

  describe("CompaniesShRole", () => {
    it("accepts all defined role types", () => {
      const roles: CompaniesShRole[] = [
        "triage",
        "executor",
        "reviewer",
        "merger",
        "scheduler",
        "engineer",
        "custom",
      ];
      expect(roles).toHaveLength(7);
    });
  });

  describe("runtime validation", () => {
    it("validates that a minimal object satisfies CompaniesShAgent shape", () => {
      // Simulate runtime validation of parsed JSON
      const parsed = JSON.parse('{"name":"Test","role":"executor"}');
      expect(typeof parsed.name).toBe("string");
      expect(typeof parsed.role).toBe("string");
      expect(parsed.name).toBe("Test");
      expect(parsed.role).toBe("executor");
    });

    it("detects missing required fields in parsed data", () => {
      const parsed = JSON.parse('{"name":"Test"}');
      expect(parsed.role).toBeUndefined();
      // This would fail validation: missing role
      expect(() => {
        if (!parsed.role) throw new Error("Missing required field: role");
      }).toThrow("Missing required field: role");
    });

    it("detects malformed data types", () => {
      const parsed = JSON.parse('{"name":123,"role":"executor"}');
      expect(typeof parsed.name).toBe("number");
      // This would fail validation: name should be string
      expect(() => {
        if (typeof parsed.name !== "string") throw new Error("name must be a string");
      }).toThrow("name must be a string");
    });
  });
});
