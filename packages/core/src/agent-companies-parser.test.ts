import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentCompaniesParseError,
  agentManifestToAgentCreateInput,
  convertAgentCompanies,
  prepareAgentCompaniesImport,
  mapRoleToCapability,
  parseAgentManifest,
  parseCompanyArchive,
  parseCompanyDirectory,
  parseCompanyManifest,
  parseProjectManifest,
  parseSingleAgentManifest,
  parseSkillManifest,
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

// Keep ZIP fixtures fully deterministic and self-contained without relying on
// external `zip` binaries that may be unavailable in CI/worktree environments.
function createZipFromEntries(
  archivePath: string,
  entries: Array<{ path: string; content: string }>,
): void {
  const localRecords: Buffer[] = [];
  const centralDirectoryRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileNameBytes = Buffer.from(entry.path, "utf-8");
    const contentBytes = Buffer.from(entry.content, "utf-8");
    const compressedBytes = zlib.deflateRawSync(contentBytes);
    const crc32 = zlib.crc32(contentBytes) >>> 0;

    const localHeader = Buffer.alloc(30 + fileNameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5000, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(compressedBytes.length, 18);
    localHeader.writeUInt32LE(contentBytes.length, 22);
    localHeader.writeUInt16LE(fileNameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileNameBytes.copy(localHeader, 30);

    localRecords.push(localHeader, compressedBytes);

    const centralRecord = Buffer.alloc(46 + fileNameBytes.length);
    centralRecord.writeUInt32LE(0x02014b50, 0);
    centralRecord.writeUInt16LE(20, 4);
    centralRecord.writeUInt16LE(20, 6);
    centralRecord.writeUInt16LE(0, 8);
    centralRecord.writeUInt16LE(8, 10);
    centralRecord.writeUInt16LE(0, 12);
    centralRecord.writeUInt16LE(0x5000, 14);
    centralRecord.writeUInt32LE(crc32, 16);
    centralRecord.writeUInt32LE(compressedBytes.length, 20);
    centralRecord.writeUInt32LE(contentBytes.length, 24);
    centralRecord.writeUInt16LE(fileNameBytes.length, 28);
    centralRecord.writeUInt16LE(0, 30);
    centralRecord.writeUInt16LE(0, 32);
    centralRecord.writeUInt16LE(0, 34);
    centralRecord.writeUInt16LE(0, 36);
    centralRecord.writeUInt32LE(0, 38);
    centralRecord.writeUInt32LE(localOffset, 42);
    fileNameBytes.copy(centralRecord, 46);
    centralDirectoryRecords.push(centralRecord);

    localOffset += localHeader.length + compressedBytes.length;
  }

  const centralDirectoryOffset = localOffset;
  const centralDirectoryBuffer = Buffer.concat(centralDirectoryRecords);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryBuffer.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  const archiveBuffer = Buffer.concat([
    ...localRecords,
    centralDirectoryBuffer,
    endOfCentralDirectory,
  ]);

  writeFileSync(archivePath, archiveBuffer);
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

    it("parses SKILL.md with instruction body", () => {
      const manifest = parseSkillManifest(`---
name: review
schema: agentcompanies/v1
kind: skill
---
# review

Add skill instructions here.`);

      expect(manifest).toEqual({
        name: "review",
        schema: "agentcompanies/v1",
        kind: "skill",
        instructionBody: "# review\n\nAdd skill instructions here.",
      });
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

    it("parses skills from skills subdirectories", () => {
      const root = createTempDir();
      writeTextFile(
        join(root, "skills", "review", "SKILL.md"),
        `---
name: review
kind: skill
---
# review`,
      );
      writeTextFile(
        join(root, "skills", "strategy", "SKILL.md"),
        `---
name: strategy
kind: skill
---
# strategy`,
      );

      const pkg = parseCompanyDirectory(root);
      expect(pkg.skills).toHaveLength(2);
      expect(pkg.skills?.map((skill) => skill.name)).toEqual(["review", "strategy"]);
    });

    it("returns empty skills when skills directory is absent", () => {
      const root = createTempDir();
      writeTextFile(
        join(root, "agents", "solo", "AGENTS.md"),
        `---
name: Solo Agent
---`,
      );

      const pkg = parseCompanyDirectory(root);
      expect(pkg.skills).toEqual([]);
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
        skills: [],
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

    it("throws AgentCompaniesParseError for a corrupt .tar.gz file", async () => {
      const root = createTempDir();
      const archivePath = join(root, "corrupt.tgz");
      writeTextFile(archivePath, "not a real gzip archive");

      await expect(parseCompanyArchive(archivePath)).rejects.toBeInstanceOf(AgentCompaniesParseError);
      await expect(parseCompanyArchive(archivePath)).rejects.toThrow(
        "Failed to parse Agent Companies archive",
      );
    });

    it("throws AgentCompaniesParseError for a non-existent .tar.gz file", async () => {
      const archivePath = join(createTempDir(), "missing.tgz");

      await expect(parseCompanyArchive(archivePath)).rejects.toBeInstanceOf(AgentCompaniesParseError);
    });

    it("parses a .zip archive", async () => {
      const root = createTempDir();
      const archivePath = join(root, "company.zip");

      createZipFromEntries(archivePath, [
        { path: "zip-company/COMPANY.md", content: `---\nname: Zip Company\nschema: agentcompanies/v1\n---` },
        { path: "zip-company/agents/ceo/AGENTS.md", content: `---\nname: Zip CEO\n---` },
      ]);

      const pkg = await parseCompanyArchive(archivePath);
      expect(pkg.company?.name).toBe("Zip Company");
      expect(pkg.agents).toHaveLength(1);
    });

    it("parses a .zip archive with COMPANY.md at root", async () => {
      const root = createTempDir();
      const archivePath = join(root, "flat.zip");

      createZipFromEntries(archivePath, [
        { path: "COMPANY.md", content: `---\nname: Flat Zip Co\n---` },
      ]);

      const pkg = await parseCompanyArchive(archivePath);
      expect(pkg.company?.name).toBe("Flat Zip Co");
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

    it("prepares imports with manager-first ordering and deferred hierarchy refs", () => {
      const { items, result } = prepareAgentCompaniesImport({
        company: { name: "Example" },
        agents: [
          { name: "IC", reportsTo: "../vp-eng/AGENTS.md" },
          { name: "CEO", slug: "ceo" },
          { name: "VP Eng", slug: "vp-eng", reportsTo: "ceo" },
        ],
        teams: [],
        projects: [],
        tasks: [],
      });

      expect(items.map((item) => item.input.name)).toEqual(["CEO", "VP Eng", "IC"]);
      expect(items[0]).not.toHaveProperty("reportsTo");
      expect(items[1]?.reportsTo).toEqual({
        raw: "ceo",
        deferredManifestKey: "ceo",
      });
      expect(items[2]?.reportsTo).toEqual({
        raw: "../vp-eng/AGENTS.md",
        deferredManifestKey: "vp-eng",
      });
      expect(result.errors).toEqual([]);
    });

    it("resolves existing manager refs by slug, path, and agent id", () => {
      const existingAgents = [
        {
          id: "agent-ceo01",
          name: "Chief Executive Officer",
          metadata: { agentCompaniesSlug: "ceo" },
        },
      ];

      const { items, result } = prepareAgentCompaniesImport(
        {
          company: { name: "Example" },
          agents: [
            { name: "Ops Lead", reportsTo: "ceo" },
            { name: "QA Lead", reportsTo: "../ceo/AGENTS.md" },
            { name: "Staff Eng", reportsTo: "agent-ceo01" },
          ],
          teams: [],
          projects: [],
          tasks: [],
        },
        { existingAgents },
      );

      expect(items.map((item) => item.input.reportsTo)).toEqual([
        "agent-ceo01",
        "agent-ceo01",
        "agent-ceo01",
      ]);
      expect(result.errors).toEqual([]);
    });

    it("keeps unresolved internal refs out of the import plan", () => {
      const { items, result } = prepareAgentCompaniesImport({
        company: { name: "Example" },
        agents: [{ name: "Worker", reportsTo: "unknown-manager" }],
        teams: [],
        projects: [],
        tasks: [],
      });

      expect(items).toEqual([]);
      expect(result).toEqual({
        created: [],
        skipped: [],
        errors: [
          {
            name: "Worker",
            error:
              'Could not resolve reportsTo reference "unknown-manager" to an imported or existing Fusion agent',
          },
        ],
      });
    });

    it("stores the manifest slug in metadata for future hierarchy resolution", () => {
      const input = agentManifestToAgentCreateInput({
        name: "CEO",
        slug: "ceo",
      });

      expect(input.metadata).toEqual({ agentCompaniesSlug: "ceo" });
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
