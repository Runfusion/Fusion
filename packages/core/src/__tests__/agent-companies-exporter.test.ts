import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseYamlFrontmatter } from "../agent-companies-parser.js";
import {
  agentToCompaniesManifest,
  exportAgentsToDirectory,
  generateAgentMd,
  generateCompanyMd,
  slugify,
} from "../agent-companies-exporter.js";
import type { Agent } from "../types.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-companies-exporter-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "agent-1",
    name: overrides.name ?? "CEO",
    role: overrides.role ?? "executor",
    state: overrides.state ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    metadata: overrides.metadata ?? {},
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.icon !== undefined ? { icon: overrides.icon } : {}),
    ...(overrides.reportsTo !== undefined ? { reportsTo: overrides.reportsTo } : {}),
    ...(overrides.instructionsText !== undefined
      ? { instructionsText: overrides.instructionsText }
      : {}),
    ...(overrides.memory !== undefined ? { memory: overrides.memory } : {}),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("agent-companies-exporter", () => {
  it("maps Agent fields to AgentCompanies manifest", () => {
    const agent = makeAgent({
      id: "agent-ceo",
      name: "CEO",
      title: "Chief Executive Officer",
      icon: "crown",
      role: "reviewer",
      reportsTo: "agent-root",
      instructionsText: "Lead strategy and review architecture.",
      memory: "Prefer concise updates and explicit risk tracking.",
      metadata: {
        description: "Company lead",
        skills: ["review", { name: "architecture" }],
      },
    });

    const manifest = agentToCompaniesManifest(agent);

    expect(manifest).toEqual({
      name: "CEO",
      title: "Chief Executive Officer",
      icon: "crown",
      role: "reviewer",
      reportsTo: "agent-root",
      skills: ["review", "architecture"],
      description: "Company lead",
      schema: "agentcompanies/v1",
      instructionBody: "Lead strategy and review architecture.",
      memory: "Prefer concise updates and explicit risk tracking.",
    });
  });

  it("generates COMPANY.md with valid YAML frontmatter", () => {
    const content = generateCompanyMd([makeAgent({ name: "Leadership" })], {
      name: "Acme Agents",
      description: "Autonomous engineering org",
      slug: "acme-agents",
    });

    const parsed = parseYamlFrontmatter(content);
    expect(parsed.frontmatter).toMatchObject({
      name: "Acme Agents",
      description: "Autonomous engineering org",
      slug: "acme-agents",
      schema: "agentcompanies/v1",
    });
    expect(parsed.body).toContain("Autonomous engineering org");
  });

  it("generates AGENTS.md with frontmatter and markdown body", () => {
    const content = generateAgentMd(
      makeAgent({
        name: "Reviewer",
        title: "Code Reviewer",
        icon: "shield",
        role: "reviewer",
        instructionsText: "Always verify tests and edge-cases.",
        memory: "Track flaky-test patterns across reviews.",
        metadata: {
          description: "Ensures quality",
          skills: ["qa"],
        },
      }),
    );

    const parsed = parseYamlFrontmatter(content);
    expect(parsed.frontmatter).toMatchObject({
      name: "Reviewer",
      title: "Code Reviewer",
      icon: "shield",
      role: "reviewer",
      reportsTo: null,
      skills: ["qa"],
      description: "Ensures quality",
      schema: "agentcompanies/v1",
      memory: "Track flaky-test patterns across reviews.",
    });
    expect(parsed.body).toBe("Always verify tests and edge-cases.");
  });

  it("exports agents and skills to Agent Companies directory layout", async () => {
    const outputDir = createTempDir();
    const ceo = makeAgent({
      id: "agent-ceo",
      name: "CEO",
      role: "executor",
      metadata: {
        description: "Company lead",
        skills: ["strategy"],
      },
      instructionsText: "Lead the company.",
    });
    const reviewer = makeAgent({
      id: "agent-reviewer",
      name: "Code Reviewer",
      role: "reviewer",
      reportsTo: "agent-ceo",
      metadata: {
        description: "Reviews code",
        skills: ["review"],
      },
      instructionsText: "Review every pull request.",
    });

    const result = await exportAgentsToDirectory([ceo, reviewer], outputDir, {
      companyName: "Acme AI",
      companySlug: "acme-ai",
    });

    expect(result.agentsExported).toBe(2);
    expect(result.skillsExported).toBe(2);
    expect(result.errors).toEqual([]);

    const companyPath = join(outputDir, "COMPANY.md");
    const reviewerPath = join(outputDir, "agents", "code-reviewer", "AGENTS.md");
    const strategySkillPath = join(outputDir, "skills", "strategy", "SKILL.md");

    expect(readFileSync(companyPath, "utf-8")).toContain("schema: agentcompanies/v1");

    const reviewerManifest = parseYamlFrontmatter(readFileSync(reviewerPath, "utf-8"));
    expect(reviewerManifest.frontmatter.reportsTo).toBe("../ceo/AGENTS.md");
    expect(reviewerManifest.frontmatter.memory).toBeUndefined();

    expect(readFileSync(strategySkillPath, "utf-8")).toContain("kind: skill");
    expect(result.filesWritten).toEqual(
      expect.arrayContaining([companyPath, reviewerPath, strategySkillPath]),
    );
  });

  it("slugifies names for directories", async () => {
    const outputDir = createTempDir();
    const agent = makeAgent({
      id: "agent-qa",
      name: "Lead QA / Ops!",
    });

    const result = await exportAgentsToDirectory([agent], outputDir);

    expect(result.agentsExported).toBe(1);
    expect(readFileSync(join(outputDir, "agents", "lead-qa-ops", "AGENTS.md"), "utf-8")).toContain(
      "name: Lead QA / Ops!",
    );
    expect(slugify("Lead QA / Ops!")).toBe("lead-qa-ops");
  });

  it("handles optional fields when reportsTo, instructionsText, and skills are absent", async () => {
    const outputDir = createTempDir();
    const agent = makeAgent({
      id: "agent-solo",
      name: "Solo",
      reportsTo: undefined,
      instructionsText: undefined,
      metadata: {},
    });

    const result = await exportAgentsToDirectory([agent], outputDir, { includeSkills: false });
    expect(result.skillsExported).toBe(0);

    const parsed = parseYamlFrontmatter(
      readFileSync(join(outputDir, "agents", "solo", "AGENTS.md"), "utf-8"),
    );
    expect(parsed.frontmatter.reportsTo).toBeNull();
    expect(parsed.frontmatter.memory).toBeUndefined();
    expect(parsed.frontmatter.skills).toEqual([]);
    expect(parsed.body).toBe("");
  });

  it("collects errors for invalid agents and continues export", async () => {
    const outputDir = createTempDir();
    const valid = makeAgent({ id: "agent-valid", name: "Valid Agent" });
    const invalid = makeAgent({ id: "agent-invalid", name: "   " });

    const result = await exportAgentsToDirectory([invalid, valid], outputDir);

    expect(result.agentsExported).toBe(1);
    expect(result.errors).toEqual([
      {
        agentId: "agent-invalid",
        error: "Agent name is required for export",
      },
    ]);
    expect(readFileSync(join(outputDir, "agents", "valid-agent", "AGENTS.md"), "utf-8")).toContain(
      "name: Valid Agent",
    );
  });

  it("exports memory in AGENTS.md frontmatter when present", async () => {
    const outputDir = createTempDir();
    const agent = makeAgent({
      id: "agent-memory",
      name: "Memory Keeper",
      memory: "Remember to include rollback plans for risky changes.",
    });

    await exportAgentsToDirectory([agent], outputDir);

    const parsed = parseYamlFrontmatter(
      readFileSync(join(outputDir, "agents", "memory-keeper", "AGENTS.md"), "utf-8"),
    );
    expect(parsed.frontmatter.memory).toBe("Remember to include rollback plans for risky changes.");
  });

  it("captures per-agent write errors", async () => {
    const outputDir = createTempDir();
    const conflictPath = join(outputDir, "agents", "ceo");
    mkdirSync(dirname(conflictPath), { recursive: true });
    writeFileSync(conflictPath, "not-a-directory", "utf-8");

    const result = await exportAgentsToDirectory(
      [
        makeAgent({ id: "agent-ceo", name: "CEO" }),
        makeAgent({ id: "agent-cto", name: "CTO" }),
      ],
      outputDir,
    );

    expect(result.agentsExported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.agentId).toBe("agent-ceo");
    expect(readFileSync(join(outputDir, "agents", "cto", "AGENTS.md"), "utf-8")).toContain(
      "name: CTO",
    );
  });
});
