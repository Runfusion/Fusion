import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentCompaniesParseError,
  agentManifestToAgentCreateInput,
  convertAgentCompanies,
  mapRoleToCapability,
  parseAgentManifest,
  parseCompanyArchive,
  parseCompanyDirectory,
  parseCompanyManifest,
  parseProjectManifest,
  parseSingleAgentManifest,
  parseTaskManifest,
  parseTeamManifest,
  parseYamlFrontmatter,
} from "./agent-companies-parser.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-companies-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function hasCommand(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("agent-companies-parser", () => {
  describe("parseYamlFrontmatter", () => {
    it("parses valid YAML frontmatter and body", () => {
      const content = `---
name: CEO
skills:
  - review
---
Lead code review.`;

      const parsed = parseYamlFrontmatter(content);
      expect(parsed.frontmatter.name).toBe("CEO");
      expect(parsed.frontmatter.skills).toEqual(["review"]);
      expect(parsed.body).toBe("Lead code review.");
    });

    it("throws when frontmatter is missing", () => {
      expect(() => parseYamlFrontmatter("name: CEO")).toThrow(AgentCompaniesParseError);
      expect(() => parseYamlFrontmatter("name: CEO")).toThrow("Missing YAML frontmatter");
    });

    it("throws when YAML is malformed", () => {
      const content = `---
name: CEO
skills: [review
---
Body`;

      expect(() => parseYamlFrontmatter(content)).toThrow("Malformed YAML frontmatter");
    });

    it("supports empty body", () => {
      const parsed = parseYamlFrontmatter(`---
name: CEO
---`);
      expect(parsed.body).toBe("");
    });

    it("parses multiline fields", () => {
      const parsed = parseYamlFrontmatter(`---
name: CEO
description: |
  First line
  Second line
---
Body`);

      expect(parsed.frontmatter.description).toBe("First line\nSecond line\n");
    });
  });

  describe("individual manifests", () => {
    it("parses full AGENTS.md", () => {
      const manifest = parseAgentManifest(`---
name: CEO
title: Chief Executive Officer
reportsTo: null
skills:
  - plan-ceo-review
  - review
---
Agent instructions.`);

      expect(manifest.name).toBe("CEO");
      expect(manifest.title).toBe("Chief Executive Officer");
      expect(manifest.reportsTo).toBeNull();
      expect(manifest.skills).toEqual(["plan-ceo-review", "review"]);
      expect(manifest.instructionBody).toBe("Agent instructions.");
    });

    it("parses minimal AGENTS.md", () => {
      const manifest = parseAgentManifest(`---
name: Solo Agent
---`);
      expect(manifest.name).toBe("Solo Agent");
      expect(manifest.instructionBody).toBe("");
    });

    it("parses standalone AGENTS.md wrapper", () => {
      const parsed = parseSingleAgentManifest(`---
name: Solo Agent
---
Be helpful.`);
      expect(parsed.manifest.name).toBe("Solo Agent");
      expect(parsed.manifest.instructionBody).toBe("Be helpful.");
    });

    it("parses COMPANY.md with schema and slug", () => {
      const manifest = parseCompanyManifest(`---
name: Lean Dev Shop
description: Small engineering-focused AI company
slug: lean-dev-shop
schema: agentcompanies/v1
---`);

      expect(manifest.schema).toBe("agentcompanies/v1");
      expect(manifest.slug).toBe("lean-dev-shop");
    });

    it("parses TEAM.md with manager and includes", () => {
      const manifest = parseTeamManifest(`---
name: Engineering
manager: ../cto/AGENTS.md
includes:
  - ../platform/TEAM.md
---`);

      expect(manifest.manager).toBe("../cto/AGENTS.md");
      expect(manifest.includes).toEqual(["../platform/TEAM.md"]);
    });

    it("parses PROJECT.md", () => {
      const manifest = parseProjectManifest(`---
name: Q2 Launch
slug: q2-launch
---`);
      expect(manifest.slug).toBe("q2-launch");
    });

    it("parses TASK.md schedule", () => {
      const manifest = parseTaskManifest(`---
name: Monday Review
assignee: ./agents/ceo/AGENTS.md
project: ./projects/q2-launch/PROJECT.md
schedule:
  timezone: America/New_York
  startsAt: "2026-04-14T09:00:00"
---`);

      expect(manifest.assignee).toBe("./agents/ceo/AGENTS.md");
      expect(manifest.schedule?.timezone).toBe("America/New_York");
    });
  });

  describe("directory parsing", () => {
    it("parses a full company directory", () => {
      const root = createTempDir();
      writeTextFile(
        join(root, "COMPANY.md"),
        `---
name: Lean Dev Shop
slug: lean-dev-shop
schema: agentcompanies/v1
---`,
      );
      writeTextFile(
        join(root, "agents", "ceo", "AGENTS.md"),
        `---
name: CEO
title: Chief Executive Officer
skills:
  - review
---
Lead reviews.`,
      );
      writeTextFile(
        join(root, "teams", "engineering", "TEAM.md"),
        `---
name: Engineering
manager: ../ceo/AGENTS.md
---`,
      );
      writeTextFile(
        join(root, "projects", "q2-launch", "PROJECT.md"),
        `---
name: Q2 Launch
---`,
      );
      writeTextFile(
        join(root, "tasks", "monday-review", "TASK.md"),
        `---
name: Monday Review
---`,
      );

      const pkg = parseCompanyDirectory(root);

      expect(pkg.company?.name).toBe("Lean Dev Shop");
      expect(pkg.agents).toHaveLength(1);
      expect(pkg.teams).toHaveLength(1);
      expect(pkg.projects).toHaveLength(1);
      expect(pkg.tasks).toHaveLength(1);
    });

    it("parses agents-only directory without COMPANY.md", () => {
      const root = createTempDir();
      writeTextFile(
        join(root, "agents", "solo", "AGENTS.md"),
        `---
name: Solo Agent
---`,
      );

      const pkg = parseCompanyDirectory(root);
      expect(pkg.company).toBeUndefined();
      expect(pkg.agents).toHaveLength(1);
      expect(pkg.teams).toEqual([]);
    });

    it("parses empty directory", () => {
      const root = createTempDir();
      const pkg = parseCompanyDirectory(root);
      expect(pkg).toEqual({
        company: undefined,
        agents: [],
        teams: [],
        projects: [],
        tasks: [],
      });
    });

    it("handles circular team includes without recursion issues", () => {
      const root = createTempDir();
      writeTextFile(
        join(root, "teams", "a", "TEAM.md"),
        `---
name: a
slug: a
includes:
  - ../b/TEAM.md
---`,
      );
      writeTextFile(
        join(root, "teams", "b", "TEAM.md"),
        `---
name: b
slug: b
includes:
  - ../a/TEAM.md
---`,
      );

      const pkg = parseCompanyDirectory(root);
      expect(pkg.teams).toHaveLength(2);
    });
  });

  describe("archive parsing", () => {
    it("parses a .tgz archive", async () => {
      const root = createTempDir();
      const packageDir = join(root, "company-package");
      writeTextFile(join(packageDir, "COMPANY.md"), `---
name: Archive Company
schema: agentcompanies/v1
---`);
      writeTextFile(join(packageDir, "agents", "ceo", "AGENTS.md"), `---
name: Archive CEO
---`);

      const archivePath = join(root, "company.tgz");
      execSync(`tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(root)} company-package`);

      const pkg = await parseCompanyArchive(archivePath);
      expect(pkg.company?.name).toBe("Archive Company");
      expect(pkg.agents[0]?.name).toBe("Archive CEO");
    });

    const zipIt = hasCommand("zip") ? it : it.skip;
    zipIt("parses a .zip archive", async () => {
      const root = createTempDir();
      const packageDir = join(root, "zip-company");
      writeTextFile(join(packageDir, "COMPANY.md"), `---
name: Zip Company
schema: agentcompanies/v1
---`);
      writeTextFile(join(packageDir, "agents", "ceo", "AGENTS.md"), `---
name: Zip CEO
---`);

      const archivePath = join(root, "company.zip");
      execSync(`zip -qr ${JSON.stringify(archivePath)} zip-company`, { cwd: root });

      const pkg = await parseCompanyArchive(archivePath);
      expect(pkg.company?.name).toBe("Zip Company");
      expect(pkg.agents).toHaveLength(1);
    });

    it("throws for unsupported archive extension", async () => {
      const root = createTempDir();
      const archivePath = join(root, "company.rar");
      writeTextFile(archivePath, "not a real archive");

      await expect(parseCompanyArchive(archivePath)).rejects.toThrow(
        "Unsupported archive format",
      );
    });
  });

  describe("conversion", () => {
    it("maps AgentManifest to AgentCreateInput", () => {
      const input = agentManifestToAgentCreateInput({
        name: "CEO",
        title: "Chief Executive Officer",
        instructionBody: "Lead strategy",
        skills: ["review"],
        reportsTo: null,
        metadata: {
          sources: [{ kind: "git", repo: "acme/repo" }],
        },
      });

      expect(input).toEqual({
        name: "CEO",
        role: "custom",
        title: "Chief Executive Officer",
        instructionsText: "Lead strategy",
        metadata: {
          skills: ["review"],
          sources: [{ kind: "git", repo: "acme/repo" }],
        },
      });
    });

    it("converts package agents with skipExisting", () => {
      const { inputs, result } = convertAgentCompanies(
        {
          company: { name: "Example" },
          agents: [{ name: "Existing" }, { name: "New Agent", title: "New" }],
          teams: [],
          projects: [],
          tasks: [],
        },
        { skipExisting: ["Existing"] },
      );

      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.name).toBe("New Agent");
      expect(result).toEqual({
        created: ["New Agent"],
        skipped: ["Existing"],
        errors: [],
      });
    });

    it("defaults to custom role when no skills are present", () => {
      const input = agentManifestToAgentCreateInput({ name: "Generalist" });
      expect(input.role).toBe("custom");
    });

    it("maps manifest icon to first-class field", () => {
      const input = agentManifestToAgentCreateInput({
        name: "Bot",
        icon: "🤖",
        role: "executor",
      });

      expect(input).toEqual({
        name: "Bot",
        role: "executor",
        icon: "🤖",
      });
    });

    it("maps manifest reportsTo to first-class field", () => {
      const input = agentManifestToAgentCreateInput({
        name: "Worker",
        reportsTo: "manager-001",
      });

      expect(input).toEqual({
        name: "Worker",
        role: "custom",
        reportsTo: "manager-001",
      });
    });

    it("maps manifest role to first-class field", () => {
      const input = agentManifestToAgentCreateInput({
        name: "Reviewer",
        role: "reviewer",
      });

      expect(input).toEqual({
        name: "Reviewer",
        role: "reviewer",
      });
    });
  });

  describe("mapRoleToCapability", () => {
    it("maps known roles and defaults unknowns to custom", () => {
      expect(mapRoleToCapability("reviewer")).toBe("reviewer");
      expect(mapRoleToCapability("unknown-role")).toBe("custom");
    });
  });
});
