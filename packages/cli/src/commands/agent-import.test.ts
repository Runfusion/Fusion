import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "@fusion/core";
import { runAgentImport } from "./agent-import.js";

function makeAgentManifest(options: {
  name: string;
  title?: string;
  slug?: string;
  reportsTo?: string;
  skills?: string[];
  body?: string;
}): string {
  const lines = ["---", `name: ${options.name}`];
  if (options.title) {
    lines.push(`title: ${options.title}`);
  }
  if (options.slug) {
    lines.push(`slug: ${options.slug}`);
  }
  if (options.reportsTo) {
    lines.push(`reportsTo: ${options.reportsTo}`);
  }
  if (options.skills && options.skills.length > 0) {
    lines.push("skills:");
    for (const skill of options.skills) {
      lines.push(`  - ${skill}`);
    }
  }
  lines.push("---", options.body ?? `${options.name} instructions`);
  return lines.join("\n");
}

function createCompanyDirectory(basePath: string, agentName = "CEO"): string {
  mkdirSync(basePath, { recursive: true });
  writeFileSync(
    join(basePath, "COMPANY.md"),
    "---\nname: Example Company\nslug: example-company\n---\nCompany description",
  );

  const teamDir = join(basePath, "teams", "engineering");
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(
    join(teamDir, "TEAM.md"),
    "---\nname: Engineering\nmanager: ../ceo/AGENTS.md\n---",
  );

  const agentDir = join(basePath, "agents", "ceo");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "AGENTS.md"),
    makeAgentManifest({
      name: agentName,
      title: "Chief Executive",
      skills: ["review"],
      body: "Lead the company",
    }),
  );

  return basePath;
}

function createHierarchyCompanyDirectory(basePath: string): string {
  mkdirSync(basePath, { recursive: true });
  writeFileSync(
    join(basePath, "COMPANY.md"),
    "---\nname: Example Company\nslug: example-company\n---\nCompany description",
  );

  mkdirSync(join(basePath, "agents", "ceo"), { recursive: true });
  writeFileSync(
    join(basePath, "agents", "ceo", "AGENTS.md"),
    makeAgentManifest({
      name: "CEO",
      slug: "ceo",
      title: "Chief Executive",
      body: "Lead the company",
    }),
  );

  mkdirSync(join(basePath, "agents", "vp-eng"), { recursive: true });
  writeFileSync(
    join(basePath, "agents", "vp-eng", "AGENTS.md"),
    makeAgentManifest({
      name: "VP Engineering",
      slug: "vp-eng",
      reportsTo: "ceo",
      body: "Lead engineering",
    }),
  );

  mkdirSync(join(basePath, "agents", "staff-eng"), { recursive: true });
  writeFileSync(
    join(basePath, "agents", "staff-eng", "AGENTS.md"),
    makeAgentManifest({
      name: "Staff Engineer",
      reportsTo: "../vp-eng/AGENTS.md",
      body: "Build systems",
    }),
  );

  return basePath;
}

function makeSkillManifest(options: {
  name: string;
  description?: string;
  slug?: string;
  version?: string;
  license?: string;
  authors?: string[];
  tags?: string[];
  instructionBody?: string;
}): string {
  const lines = ["---"];
  lines.push(`name: ${options.name}`);
  if (options.description) lines.push(`description: ${options.description}`);
  if (options.slug) lines.push(`slug: ${options.slug}`);
  if (options.version) lines.push(`version: ${options.version}`);
  if (options.license) lines.push(`license: ${options.license}`);
  if (options.authors && options.authors.length > 0) {
    lines.push("authors:");
    for (const author of options.authors) {
      lines.push(`  - ${author}`);
    }
  }
  if (options.tags && options.tags.length > 0) {
    lines.push("tags:");
    for (const tag of options.tags) {
      lines.push(`  - ${tag}`);
    }
  }
  lines.push("---");
  if (options.instructionBody) {
    lines.push(options.instructionBody);
  }
  return lines.join("\n");
}

function createCompanyDirectoryWithSkills(basePath: string, skills: Array<{
  name: string;
  description?: string;
  instructionBody?: string;
}>): string {
  // Create base company structure
  mkdirSync(basePath, { recursive: true });
  writeFileSync(
    join(basePath, "COMPANY.md"),
    "---\nname: Example Company\nslug: example-company\n---\nCompany description",
  );

  const agentDir = join(basePath, "agents", "ceo");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "AGENTS.md"),
    makeAgentManifest({
      name: "CEO",
      title: "Chief Executive",
      body: "Lead the company",
    }),
  );

  // Create skills
  const skillsDir = join(basePath, "skills");
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.name.toLowerCase().replace(/\s+/g, "-"));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      makeSkillManifest({
        name: skill.name,
        description: skill.description,
        instructionBody: skill.instructionBody,
      }),
    );
  }

  return basePath;
}

describe("agent-import", () => {
  const tmpDir = join(tmpdir(), `fn-agent-import-test-${process.pid}`);
  let createAgentMock: ReturnType<typeof vi.fn>;
  let listAgentsMock: ReturnType<typeof vi.fn>;
  let initMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    createAgentMock = vi.fn().mockImplementation(async (input: any) => ({
      id: `agent-${String(input.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      ...input,
    }));
    listAgentsMock = vi.fn().mockResolvedValue([]);
    initMock = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(AgentStore.prototype, "init").mockImplementation(initMock);
    vi.spyOn(AgentStore.prototype, "listAgents").mockImplementation(listAgentsMock);
    vi.spyOn(AgentStore.prototype, "createAgent").mockImplementation(createAgentMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("reports error on invalid source path", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runAgentImport(join(tmpDir, "missing"))).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Path not found"));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("reports parse error on malformed AGENTS.md", async () => {
    const manifestPath = join(tmpDir, "AGENTS.md");
    writeFileSync(manifestPath, "name: missing frontmatter delimiters");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runAgentImport(manifestPath)).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Parse error"));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("handles empty directory gracefully", async () => {
    const emptyDir = join(tmpDir, "empty-company");
    mkdirSync(emptyDir, { recursive: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(emptyDir);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No agents found"));
    logSpy.mockRestore();
  });

  it("imports agents from an Agent Companies directory", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-dir"));

    await runAgentImport(companyDir);

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "CEO", role: "custom", title: "Chief Executive" }),
    );
  });

  it("resolves imported manager hierarchy to created Fusion agent ids", async () => {
    const companyDir = createHierarchyCompanyDirectory(join(tmpDir, "company-hierarchy"));
    createAgentMock
      .mockResolvedValueOnce({ id: "agent-ceo", name: "CEO" })
      .mockResolvedValueOnce({ id: "agent-vp-eng", name: "VP Engineering" })
      .mockResolvedValueOnce({ id: "agent-staff-eng", name: "Staff Engineer" });

    await runAgentImport(companyDir);

    expect(createAgentMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: "CEO",
      role: "custom",
    }));
    expect(createAgentMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "VP Engineering",
      role: "custom",
      reportsTo: "agent-ceo",
    }));
    expect(createAgentMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
      name: "Staff Engineer",
      role: "custom",
      reportsTo: "agent-vp-eng",
    }));
  });

  it("resolves skipped existing managers before importing their reports", async () => {
    const companyDir = createHierarchyCompanyDirectory(join(tmpDir, "company-existing-manager"));
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-ceo-existing",
        name: "CEO",
        role: "custom",
        metadata: { agentCompaniesSlug: "ceo" },
      },
    ]);

    await runAgentImport(companyDir, { skipExisting: true });

    expect(createAgentMock).toHaveBeenCalledTimes(2);
    expect(createAgentMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: "VP Engineering",
      reportsTo: "agent-ceo-existing",
    }));
    expect(createAgentMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: "Staff Engineer",
      reportsTo: "agent-vp-engineering",
    }));
  });

  it("imports agents from a single AGENTS.md file", async () => {
    const manifestPath = join(tmpDir, "AGENTS.md");
    writeFileSync(
      manifestPath,
      makeAgentManifest({
        name: "Solo Agent",
        title: "Single File Agent",
        skills: ["review"],
      }),
    );

    await runAgentImport(manifestPath);

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Solo Agent", role: "custom" }),
    );
  });

  it("imports agents from a .tar.gz archive", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-archive-src"), "Archive CEO");
    const archivePath = join(tmpDir, "company.tar.gz");

    execSync(`tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(companyDir)} .`);

    await runAgentImport(archivePath);

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Archive CEO", role: "custom" }),
    );
  });

  it("supports dry-run mode", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-dry-run"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAgentImport(companyDir, { dryRun: true });

    expect(createAgentMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("[DRY RUN]");
    expect(output).toContain("Agents: 1");
    expect(output).toContain("Teams: 1");

    logSpy.mockRestore();
  });

  it("supports skip-existing", async () => {
    const companyDir = createCompanyDirectory(join(tmpDir, "company-skip"));
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "CEO", role: "custom" }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAgentImport(companyDir, { skipExisting: true });

    expect(createAgentMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Skipped: 1");

    logSpy.mockRestore();
  });

  it("reports unsupported file formats", async () => {
    const unsupportedPath = join(tmpDir, "manifest.json");
    writeFileSync(unsupportedPath, JSON.stringify({ name: "Not a manifest" }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runAgentImport(unsupportedPath)).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported format"));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("skill import", () => {
    const projectDir = join(tmpDir, "test-project");
    const originalCwd = process.cwd();

    beforeEach(() => {
      mkdirSync(projectDir, { recursive: true });
      // Create .fusion directory with fusion.db to make it detectable as a project
      mkdirSync(join(projectDir, ".fusion"), { recursive: true });
      writeFileSync(join(projectDir, ".fusion", "fusion.db"), "");
      // Change to project directory so project auto-detection works
      process.chdir(projectDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
    });

    it("imports skills from directory package to skills/imported directory", async () => {
      const companyDir = createCompanyDirectoryWithSkills(
        join(tmpDir, "company-with-skills"),
        [
          { name: "Code Review", description: "Review code changes", instructionBody: "Review all PRs carefully" },
          { name: "Strategy", instructionBody: "Plan the roadmap" },
        ],
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentImport(companyDir);

      // Verify skill files were created
      const skillDir = join(projectDir, "skills", "imported", "example-company");
      expect(existsSync(join(skillDir, "code-review", "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillDir, "strategy", "SKILL.md"))).toBe(true);

      // Verify output includes skill results
      const output = logSpy.mock.calls.flat().join(" ");
      expect(output).toContain("Skills:");
      expect(output).toContain("2 imported");

      logSpy.mockRestore();
    });

    it("generates skill markdown with required frontmatter keys", async () => {
      const companyDir = createCompanyDirectoryWithSkills(
        join(tmpDir, "company-frontmatter-test"),
        [{ name: "Test Skill", instructionBody: "Test instructions" }],
      );

      await runAgentImport(companyDir);

      const skillContent = readFileSync(
        join(projectDir, "skills", "imported", "example-company", "test-skill", "SKILL.md"),
        "utf-8",
      );

      // Check required frontmatter keys
      expect(skillContent).toContain("name: Test Skill");
      expect(skillContent).toContain("schema: agentcompanies/v1");
      expect(skillContent).toContain("kind: skill");
      // Check body
      expect(skillContent).toContain("Test instructions");
    });

    it("includes optional frontmatter fields when present", async () => {
      const companyDir = join(tmpDir, "company-optional-frontmatter");
      mkdirSync(companyDir, { recursive: true });
      writeFileSync(
        join(companyDir, "COMPANY.md"),
        "---\nname: Test Co\nslug: test-co\n---",
      );
      mkdirSync(join(companyDir, "agents", "test"), { recursive: true });
      writeFileSync(
        join(companyDir, "agents", "test", "AGENTS.md"),
        makeAgentManifest({ name: "Test Agent" }),
      );
      const skillDir = join(companyDir, "skills", "my-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        makeSkillManifest({
          name: "My Skill",
          slug: "custom-slug",
          description: "A test skill",
          version: "1.0.0",
          license: "MIT",
          authors: ["Author One", "Author Two"],
          tags: ["testing", "example"],
          instructionBody: "Do the thing",
        }),
      );

      await runAgentImport(companyDir);

      const skillContent = readFileSync(
        join(projectDir, "skills", "imported", "test-co", "my-skill", "SKILL.md"),
        "utf-8",
      );

      expect(skillContent).toContain("description: A test skill");
      expect(skillContent).toContain("version: 1.0.0");
      expect(skillContent).toContain("license: MIT");
      expect(skillContent).toContain("authors:");
      expect(skillContent).toContain("- Author One");
      expect(skillContent).toContain("- Author Two");
      expect(skillContent).toContain("tags:");
      expect(skillContent).toContain("- testing");
      expect(skillContent).toContain("- example");
    });

    it("uses fallback template for skill without instruction body", async () => {
      const companyDir = join(tmpDir, "company-no-body");
      mkdirSync(companyDir, { recursive: true });
      writeFileSync(
        join(companyDir, "COMPANY.md"),
        "---\nname: Test Co\nslug: test-co\n---",
      );
      mkdirSync(join(companyDir, "agents", "test"), { recursive: true });
      writeFileSync(
        join(companyDir, "agents", "test", "AGENTS.md"),
        makeAgentManifest({ name: "Test Agent" }),
      );
      const skillDir = join(companyDir, "skills", "bare-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: Bare Skill\n---\n",
      );

      await runAgentImport(companyDir);

      const skillContent = readFileSync(
        join(projectDir, "skills", "imported", "test-co", "bare-skill", "SKILL.md"),
        "utf-8",
      );

      expect(skillContent).toContain("# Bare Skill");
    });

    it("skips existing skill files and reports them", async () => {
      const companyDir = createCompanyDirectoryWithSkills(
        join(tmpDir, "company-existing-skill"),
        [{ name: "Existing Skill", instructionBody: "Original content" }],
      );

      // Pre-create the skill file
      const existingSkillDir = join(projectDir, "skills", "imported", "example-company", "existing-skill");
      mkdirSync(existingSkillDir, { recursive: true });
      writeFileSync(join(existingSkillDir, "SKILL.md"), "---\nname: Existing Skill\n---\nAlready exists");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentImport(companyDir);

      const output = logSpy.mock.calls.flat().join(" ");
      expect(output).toContain("1 skipped");
      expect(output).toContain("Existing Skill");

      // Verify file was not overwritten
      const skillContent = readFileSync(join(existingSkillDir, "SKILL.md"), "utf-8");
      expect(skillContent).toContain("Already exists");

      logSpy.mockRestore();
    });

    it("does not write skill files in dry-run mode", async () => {
      const companyDir = createCompanyDirectoryWithSkills(
        join(tmpDir, "company-dry-run-skills"),
        [{ name: "Dry Run Skill", instructionBody: "Should not be written" }],
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentImport(companyDir, { dryRun: true });

      // Verify skill file was NOT created
      const skillPath = join(projectDir, "skills", "imported", "example-company", "dry-run-skill", "SKILL.md");
      expect(existsSync(skillPath)).toBe(false);

      // Verify output shows what would be imported
      const output = logSpy.mock.calls.flat().join(" ");
      expect(output).toContain("[DRY RUN]");
      expect(output).toContain("1 imported");

      logSpy.mockRestore();
    });

    it("does not import skills for single AGENTS.md file", async () => {
      const manifestPath = join(tmpDir, "solo-agent-with-skill.md");
      writeFileSync(
        manifestPath,
        makeAgentManifest({
          name: "Solo Agent",
          skills: ["some-skill"],
        }),
      );

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentImport(manifestPath);

      const output = logSpy.mock.calls.flat().join(" ");
      // Should not have a Skills section for single file imports
      expect(output).not.toContain("Skills:");

      logSpy.mockRestore();
    });

    it("imports skills from tar.gz archive", async () => {
      const companyDir = createCompanyDirectoryWithSkills(
        join(tmpDir, "company-archive-skills"),
        [{ name: "Archived Skill", instructionBody: "From archive" }],
      );
      const archivePath = join(tmpDir, "company-with-skills.tar.gz");
      execSync(`tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(companyDir)} .`);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await runAgentImport(archivePath);

      // Verify skill file was created
      const skillDir = join(projectDir, "skills", "imported", "example-company");
      expect(existsSync(join(skillDir, "archived-skill", "SKILL.md"))).toBe(true);

      const output = logSpy.mock.calls.flat().join(" ");
      expect(output).toContain("Skills:");
      expect(output).toContain("1 imported");

      logSpy.mockRestore();
    });

    it("handles company without slug using fallback directory name", async () => {
      const companyDir = join(tmpDir, "company-no-slug");
      mkdirSync(companyDir, { recursive: true });
      writeFileSync(
        join(companyDir, "COMPANY.md"),
        "---\nname: Company Without Slug\n---\nNo slug provided",
      );
      mkdirSync(join(companyDir, "agents", "test"), { recursive: true });
      writeFileSync(
        join(companyDir, "agents", "test", "AGENTS.md"),
        makeAgentManifest({ name: "Test Agent" }),
      );
      const skillDir = join(companyDir, "skills", "no-slug-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        makeSkillManifest({ name: "No Slug Skill" }),
      );

      await runAgentImport(companyDir);

      // Should use "unknown-company" fallback
      const skillDir2 = join(projectDir, "skills", "imported", "unknown-company", "no-slug-skill");
      expect(existsSync(join(skillDir2, "SKILL.md"))).toBe(true);
    });

    it("uses company slug for directory naming", async () => {
      const companyDir = join(tmpDir, "company-custom-slug");
      mkdirSync(companyDir, { recursive: true });
      writeFileSync(
        join(companyDir, "COMPANY.md"),
        "---\nname: Custom Name\nslug: my-custom-slug\n---",
      );
      mkdirSync(join(companyDir, "agents", "test"), { recursive: true });
      writeFileSync(
        join(companyDir, "agents", "test", "AGENTS.md"),
        makeAgentManifest({ name: "Test Agent" }),
      );
      const skillDir = join(companyDir, "skills", "slugged-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        makeSkillManifest({ name: "Slugged Skill" }),
      );

      await runAgentImport(companyDir);

      // Should use the custom slug
      const skillDir2 = join(projectDir, "skills", "imported", "my-custom-slug", "slugged-skill");
      expect(existsSync(join(skillDir2, "SKILL.md"))).toBe(true);
    });
  });
});
