import { describe, it, expect } from "vitest";
import {
  parseCompaniesShManifest,
  companiesShAgentToAgentCreateInput,
  convertCompaniesShAgents,
  mapRoleToCapability,
  CompaniesShParseError,
} from "./companies-sh-parser.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function encodeManifest(agents: unknown[]): string {
  return Buffer.from(JSON.stringify(agents)).toString("base64");
}

function makeScript(companyName: string, agents: unknown[], envLines?: string[]): string {
  const manifest = encodeManifest(agents);
  let script = `#!/bin/bash\n# Agent Company Manifest\nCOMPANY_NAME="${companyName}"\nAGENT_MANIFEST="${manifest}"`;
  if (envLines && envLines.length > 0) {
    script += "\n\n" + envLines.join("\n");
  }
  return script;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("companies-sh-parser", () => {
  describe("parseCompaniesShManifest", () => {
    it("parses a valid companies.sh manifest", () => {
      const agents = [
        {
          name: "Code Reviewer",
          role: "reviewer",
          capabilities: ["code-review", "security-audit"],
          config: { model: "claude-sonnet-4", maxTokens: 4096, thinkingLevel: "medium" },
          metadata: { title: "Senior Code Reviewer", icon: "👁" },
        },
      ];
      const script = makeScript("test-company", agents, [
        'export KB_AGENT_MODEL="${KB_AGENT_MODEL:-claude-sonnet-4}"',
      ]);

      const manifest = parseCompaniesShManifest(script);

      expect(manifest.companyName).toBe("test-company");
      expect(manifest.agents).toHaveLength(1);
      expect(manifest.agents[0].name).toBe("Code Reviewer");
      expect(manifest.agents[0].role).toBe("reviewer");
      expect(manifest.agents[0].capabilities).toEqual(["code-review", "security-audit"]);
      expect(manifest.agents[0].config?.model).toBe("claude-sonnet-4");
      expect(manifest.agents[0].metadata?.title).toBe("Senior Code Reviewer");
      expect(manifest.envVars).toHaveLength(1);
      expect(manifest.envVars[0].name).toBe("KB_AGENT_MODEL");
      expect(manifest.envVars[0].defaultValue).toBe("claude-sonnet-4");
    });

    it("parses a manifest with multiple agents", () => {
      const agents = [
        { name: "Agent 1", role: "executor" },
        { name: "Agent 2", role: "reviewer" },
        { name: "Agent 3", role: "triage" },
      ];
      const script = makeScript("multi-agent", agents);

      const manifest = parseCompaniesShManifest(script);

      expect(manifest.agents).toHaveLength(3);
      expect(manifest.agents.map((a) => a.name)).toEqual(["Agent 1", "Agent 2", "Agent 3"]);
    });

    it("throws on empty content", () => {
      expect(() => parseCompaniesShManifest("")).toThrow(CompaniesShParseError);
      expect(() => parseCompaniesShManifest("")).toThrow("empty or not a string");
    });

    it("throws on missing COMPANY_NAME", () => {
      const manifest = encodeManifest([{ name: "Test", role: "executor" }]);
      const script = `#!/bin/bash\nAGENT_MANIFEST="${manifest}"`;

      expect(() => parseCompaniesShManifest(script)).toThrow("Missing COMPANY_NAME");
    });

    it("throws on missing AGENT_MANIFEST", () => {
      const script = `#!/bin/bash\nCOMPANY_NAME="test"`;

      expect(() => parseCompaniesShManifest(script)).toThrow("Missing AGENT_MANIFEST");
    });

    it("throws on invalid base64 encoding", () => {
      const script = `#!/bin/bash\nCOMPANY_NAME="test"\nAGENT_MANIFEST="not-valid-base64!!!"`;

      expect(() => parseCompaniesShManifest(script)).toThrow("Invalid base64");
    });

    it("throws on invalid JSON in manifest", () => {
      const badJson = btoa("not json");
      const script = `#!/bin/bash\nCOMPANY_NAME="test"\nAGENT_MANIFEST="${badJson}"`;

      expect(() => parseCompaniesShManifest(script)).toThrow("Invalid JSON");
    });

    it("throws when manifest decodes to non-array", () => {
      const obj = btoa(JSON.stringify({ name: "not an array" }));
      const script = `#!/bin/bash\nCOMPANY_NAME="test"\nAGENT_MANIFEST="${obj}"`;

      expect(() => parseCompaniesShManifest(script)).toThrow("must decode to a JSON array");
    });

    it("throws on agent missing name", () => {
      const agents = [{ role: "executor" }];
      const script = makeScript("test", agents);

      expect(() => parseCompaniesShManifest(script)).toThrow("missing required field: name");
    });

    it("throws on agent missing role", () => {
      const agents = [{ name: "Test Agent" }];
      const script = makeScript("test", agents);

      expect(() => parseCompaniesShManifest(script)).toThrow("missing required field: role");
    });

    it("throws on agent with empty name", () => {
      const agents = [{ name: "  ", role: "executor" }];
      const script = makeScript("test", agents);

      expect(() => parseCompaniesShManifest(script)).toThrow("missing required field: name");
    });

    it("throws on agent with empty role", () => {
      const agents = [{ name: "Test", role: "" }];
      const script = makeScript("test", agents);

      expect(() => parseCompaniesShManifest(script)).toThrow("missing required field: role");
    });

    it("handles empty capabilities array", () => {
      const agents = [{ name: "Test", role: "executor", capabilities: [] }];
      const script = makeScript("test", agents);

      const manifest = parseCompaniesShManifest(script);
      expect(manifest.agents[0].capabilities).toEqual([]);
    });

    it("handles agents with no optional fields", () => {
      const agents = [{ name: "Minimal", role: "custom" }];
      const script = makeScript("test", agents);

      const manifest = parseCompaniesShManifest(script);
      expect(manifest.agents[0].capabilities).toBeUndefined();
      expect(manifest.agents[0].config).toBeUndefined();
      expect(manifest.agents[0].metadata).toBeUndefined();
    });

    it("extracts multiple environment variables", () => {
      const agents = [{ name: "Test", role: "executor" }];
      const script = makeScript("test", agents, [
        'export KB_MODEL="${KB_MODEL:-claude-sonnet-4}"',
        'export KB_THINKING="${KB_THINKING:-medium}"',
        'export KB_MAX_TOKENS="${KB_MAX_TOKENS:-4096}"',
      ]);

      const manifest = parseCompaniesShManifest(script);

      expect(manifest.envVars).toHaveLength(3);
      expect(manifest.envVars.map((v) => v.name)).toEqual([
        "KB_MODEL",
        "KB_THINKING",
        "KB_MAX_TOKENS",
      ]);
    });

    it("returns empty envVars when no export statements", () => {
      const agents = [{ name: "Test", role: "executor" }];
      const script = makeScript("test", agents);

      const manifest = parseCompaniesShManifest(script);
      expect(manifest.envVars).toEqual([]);
    });

    it("handles non-object agent entries", () => {
      const agents = ["not an object", 42, null];
      const script = makeScript("test", agents);

      expect(() => parseCompaniesShManifest(script)).toThrow("not an object");
    });

    it("filters non-string capabilities", () => {
      const agents = [{ name: "Test", role: "executor", capabilities: ["valid", 123, null, "also-valid"] }];
      const script = makeScript("test", agents);

      const manifest = parseCompaniesShManifest(script);
      expect(manifest.agents[0].capabilities).toEqual(["valid", "also-valid"]);
    });
  });

  describe("mapRoleToCapability", () => {
    it("maps all known roles correctly", () => {
      expect(mapRoleToCapability("triage")).toBe("triage");
      expect(mapRoleToCapability("executor")).toBe("executor");
      expect(mapRoleToCapability("reviewer")).toBe("reviewer");
      expect(mapRoleToCapability("merger")).toBe("merger");
      expect(mapRoleToCapability("scheduler")).toBe("scheduler");
      expect(mapRoleToCapability("engineer")).toBe("engineer");
      expect(mapRoleToCapability("custom")).toBe("custom");
    });

    it("maps unknown roles to custom", () => {
      expect(mapRoleToCapability("analyst")).toBe("custom");
      expect(mapRoleToCapability("designer")).toBe("custom");
      expect(mapRoleToCapability("")).toBe("custom");
    });
  });

  describe("companiesShAgentToAgentCreateInput", () => {
    it("converts a minimal agent", () => {
      const agent = { name: "Test", role: "executor" };
      const input = companiesShAgentToAgentCreateInput(agent);

      expect(input.name).toBe("Test");
      expect(input.role).toBe("executor");
      expect(input.metadata).toBeUndefined();
      expect(input.runtimeConfig).toBeUndefined();
    });

    it("converts a fully populated agent", () => {
      const agent = {
        name: "Code Reviewer",
        role: "reviewer",
        capabilities: ["code-review"],
        config: {
          model: "claude-sonnet-4",
          maxTokens: 4096,
          thinkingLevel: "medium" as const,
          maxTurns: 10,
        },
        metadata: {
          title: "Senior Reviewer",
          icon: "👁",
          description: "Reviews code for quality",
        },
      };

      const input = companiesShAgentToAgentCreateInput(agent);

      expect(input.name).toBe("Code Reviewer");
      expect(input.role).toBe("reviewer");
      expect(input.title).toBe("Senior Reviewer");
      expect(input.icon).toBe("👁");
      expect(input.runtimeConfig).toEqual({
        model: "claude-sonnet-4",
        maxTokens: 4096,
        thinkingLevel: "medium",
        maxTurns: 10,
      });
      expect(input.metadata).toEqual({
        capabilities: ["code-review"],
        description: "Reviews code for quality",
      });
    });

    it("maps unknown roles to custom", () => {
      const agent = { name: "Special", role: "analyst" };
      const input = companiesShAgentToAgentCreateInput(agent);

      expect(input.role).toBe("custom");
    });

    it("handles agent with empty capabilities", () => {
      const agent = { name: "Test", role: "executor", capabilities: [] };
      const input = companiesShAgentToAgentCreateInput(agent);

      expect(input.metadata).toBeUndefined();
    });
  });

  describe("convertCompaniesShAgents", () => {
    it("converts all agents when no duplicates", () => {
      const agents = [
        { name: "Agent 1", role: "executor" },
        { name: "Agent 2", role: "reviewer" },
      ];

      const { inputs, result } = convertCompaniesShAgents(agents);

      expect(inputs).toHaveLength(2);
      expect(result.created).toEqual(["Agent 1", "Agent 2"]);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("skips agents with existing names", () => {
      const agents = [
        { name: "Existing Agent", role: "executor" },
        { name: "New Agent", role: "reviewer" },
      ];

      const { inputs, result } = convertCompaniesShAgents(agents, {
        skipExisting: ["Existing Agent"],
      });

      expect(inputs).toHaveLength(1);
      expect(inputs[0].name).toBe("New Agent");
      expect(result.skipped).toEqual(["Existing Agent"]);
    });

    it("handles empty agent list", () => {
      const { inputs, result } = convertCompaniesShAgents([]);

      expect(inputs).toHaveLength(0);
      expect(result.created).toEqual([]);
    });
  });
});
