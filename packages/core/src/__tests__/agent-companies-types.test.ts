import { describe, expect, it } from "vitest";
import type {
  AgentCompaniesFrontmatter,
  AgentCompaniesImportResult,
  AgentCompaniesKind,
  AgentCompaniesPackage,
  AgentCompaniesSchema,
  AgentManifest,
  CompanyManifest,
  ProjectManifest,
  SourceReference,
  TaskManifest,
  TeamManifest,
} from "../agents/agent-companies-types.js";

describe("agent-companies-types", () => {
  it("supports schema and kind literals", () => {
    const schema: AgentCompaniesSchema = "agentcompanies/v1";
    const kinds: AgentCompaniesKind[] = ["company", "team", "agent", "project", "task", "skill"];

    expect(schema).toBe("agentcompanies/v1");
    expect(kinds).toHaveLength(6);
  });

  it("supports shared frontmatter with source metadata", () => {
    const source: SourceReference = {
      kind: "git",
      repo: "acme/agent-company",
      path: "agents/ceo/AGENTS.md",
      commit: "abc123",
      hash: "sha256:def456",
      url: "https://example.com/repo",
      trackingRef: "main",
    };

    const frontmatter: AgentCompaniesFrontmatter = {
      name: "Lean Dev Shop",
      description: "Small engineering-focused AI company",
      slug: "lean-dev-shop",
      schema: "agentcompanies/v1",
      kind: "company",
      version: "1.0.0",
      license: "MIT",
      authors: ["Fusion Team"],
      tags: ["ai", "engineering"],
      metadata: {
        sources: [source],
      },
    };

    expect(frontmatter.metadata?.sources?.[0]?.repo).toBe("acme/agent-company");
  });

  it("supports company/team/agent/project/task manifests", () => {
    const company: CompanyManifest = {
      name: "Lean Dev Shop",
      goals: ["Ship high-quality software"],
      requirements: ["Use review workflow"],
    };

    const team: TeamManifest = {
      name: "Engineering",
      manager: "../cto/AGENTS.md",
      includes: ["../platform/AGENTS.md"],
    };

    const agent: AgentManifest = {
      name: "CEO",
      title: "Chief Executive Officer",
      reportsTo: null,
      skills: ["plan-ceo-review", "review"],
      instructionBody: "Lead strategy and review architecture.",
    };

    const project: ProjectManifest = {
      name: "Q2 Launch",
      slug: "q2-launch",
    };

    const task: TaskManifest = {
      name: "Monday Review",
      assignee: "./agents/ceo/AGENTS.md",
      project: "./projects/q2-launch/PROJECT.md",
      schedule: {
        timezone: "America/New_York",
        startsAt: "2026-04-14T09:00:00",
      },
    };

    expect(company.goals).toHaveLength(1);
    expect(team.includes).toEqual(["../platform/AGENTS.md"]);
    expect(agent.reportsTo).toBeNull();
    expect(project.slug).toBe("q2-launch");
    expect(task.schedule?.timezone).toBe("America/New_York");
  });

  it("supports package and import result shapes", () => {
    const pkg: AgentCompaniesPackage = {
      company: { name: "Lean Dev Shop" },
      agents: [{ name: "CEO" }],
      teams: [{ name: "Engineering" }],
      projects: [{ name: "Q2 Launch" }],
      tasks: [{ name: "Monday Review" }],
    };

    const result: AgentCompaniesImportResult = {
      created: ["CEO"],
      skipped: ["CTO"],
      errors: [{ name: "Reviewer", error: "invalid manifest" }],
    };

    expect(pkg.agents[0].name).toBe("CEO");
    expect(result.errors[0]?.name).toBe("Reviewer");
  });
});
