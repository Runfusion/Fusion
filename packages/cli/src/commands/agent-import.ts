/**
 * CLI command for importing agents from Agent Companies packages.
 *
 * Usage:
 *   fn agent import <source> [--dry-run] [--skip-existing] [--project <name>]
 *
 * @module agent-import
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentStore,
  parseCompanyDirectory,
  parseCompanyArchive,
  parseSingleAgentManifest,
  prepareAgentCompaniesImport,
  AgentCompaniesParseError,
} from "@fusion/core";
import type { AgentCreateInput } from "@fusion/core";
import type { SkillManifest } from "@fusion/core";
import { stringify as stringifyYaml } from "yaml";
import { resolveProject } from "../project-context.js";

export interface SkillImportResult {
  imported: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

const UNSUPPORTED_FORMAT_MESSAGE =
  "Unsupported format. Provide an Agent Companies directory, .tar.gz/.tgz/.zip archive, or AGENTS.md file.";

/**
 * Convert a string to a safe path segment (slug).
 * - Lowercase
 * - Replace spaces with hyphens
 * - Remove characters that are not alphanumeric, hyphens, or underscores
 * - Collapse multiple hyphens/underscores to single
 * - Trim leading/trailing hyphens/underscores
 * - Fallback to "unnamed" if empty after sanitization
 */
function slugifyPathSegment(input: string): string {
  if (!input || typeof input !== "string") {
    return "unnamed";
  }
  const slug = input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^-+|-+$/g, "")
    .replace(/^_+|_+$/g, "");
  if (!slug) {
    return "unnamed";
  }
  return slug.slice(0, 64);
}

/**
 * Generate SKILL.md content from a SkillManifest.
 * Uses the same format as the dashboard/skills adapter.
 */
function toSkillMarkdown(skill: SkillManifest): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    schema: "agentcompanies/v1",
    kind: "skill",
  };

  // Copy optional fields when present and valid
  if (typeof skill.description === "string" && skill.description.length > 0) {
    frontmatter.description = skill.description;
  }
  if (typeof skill.slug === "string" && skill.slug.length > 0) {
    frontmatter.slug = skill.slug;
  }
  if (typeof skill.version === "string" && skill.version.length > 0) {
    frontmatter.version = skill.version;
  }
  if (typeof skill.license === "string" && skill.license.length > 0) {
    frontmatter.license = skill.license;
  }
  if (Array.isArray(skill.authors) && skill.authors.length > 0) {
    frontmatter.authors = skill.authors.filter((a): a is string => typeof a === "string" && a.length > 0);
  }
  if (Array.isArray(skill.tags) && skill.tags.length > 0) {
    frontmatter.tags = skill.tags.filter((t): t is string => typeof t === "string" && t.length > 0);
  }

  const body = skill.instructionBody && skill.instructionBody.trim().length > 0
    ? skill.instructionBody
    : `# ${skill.name}`;

  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Import skills from a package to the project skills directory.
 * Skills are written to: {projectPath}/skills/imported/{companySlug}/{skillSlug}/SKILL.md
 */
async function importSkillsToProject(
  projectPath: string,
  skills: SkillManifest[],
  companySlug: string | undefined,
  dryRun: boolean,
): Promise<SkillImportResult> {
  const result: SkillImportResult = {
    imported: [],
    skipped: [],
    errors: [],
  };

  const companyDir = slugifyPathSegment(companySlug ?? "unknown-company");
  const baseSkillsDir = resolve(projectPath, "skills", "imported", companyDir);

  for (const skill of skills) {
    // Skip skills without a name
    if (!skill.name || typeof skill.name !== "string" || skill.name.trim().length === 0) {
      result.errors.push({ name: "(unnamed)", error: "Skill is missing required 'name' field" });
      continue;
    }

    const skillSlug = slugifyPathSegment(skill.name);
    const skillDir = resolve(baseSkillsDir, skillSlug);
    const skillPath = resolve(skillDir, "SKILL.md");

    // Check if skill already exists
    if (existsSync(skillPath)) {
      result.skipped.push(skill.name);
      continue;
    }

    if (dryRun) {
      // In dry-run mode, just report what would be imported
      result.imported.push(skill.name);
      continue;
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillPath, toSkillMarkdown(skill), "utf-8");
      result.imported.push(skill.name);
    } catch (err) {
      result.errors.push({ name: skill.name, error: (err as Error).message });
    }
  }

  return result;
}

/**
 * Get the project path for agent operations.
 * Falls back to process.cwd() if no project is specified.
 */
async function getProjectPath(projectName?: string): Promise<string> {
  if (projectName) {
    const context = await resolveProject(projectName);
    return context.projectPath;
  }

  try {
    const context = await resolveProject(undefined);
    return context.projectPath;
  } catch {
    return process.cwd();
  }
}

/**
 * Print a summary of the import result.
 */
function printSummary(
  companyName: string | undefined,
  agentCount: number,
  teamCount: number,
  created: string[],
  skipped: string[],
  errors: Array<{ name: string; error: string }>,
  dryRun: boolean,
  skillResult?: SkillImportResult,
): void {
  const prefix = dryRun ? "[DRY RUN] " : "";
  console.log();
  console.log(`  ${prefix}Company: ${companyName ?? "Unknown"}`);
  console.log(`  ${prefix}Agents: ${agentCount}`);
  console.log(`  ${prefix}Teams: ${teamCount}`);
  console.log(`  ${prefix}Created: ${created.length}`);
  for (const name of created) {
    console.log(`    ✓ ${name}`);
  }
  if (skipped.length > 0) {
    console.log(`  ${prefix}Skipped: ${skipped.length}`);
    for (const name of skipped) {
      console.log(`    ○ ${name}`);
    }
  }
  if (errors.length > 0) {
    console.log(`  ${prefix}Errors: ${errors.length}`);
    for (const err of errors) {
      console.log(`    ✗ ${err.name}: ${err.error}`);
    }
  }
  if (skillResult) {
    console.log(`  ${prefix}Skills: ${skillResult.imported.length} imported, ${skillResult.skipped.length} skipped, ${skillResult.errors.length} errors`);
    for (const name of skillResult.imported) {
      console.log(`    ✓ ${name}`);
    }
    for (const name of skillResult.skipped) {
      console.log(`    ○ ${name}`);
    }
    for (const err of skillResult.errors) {
      console.log(`    ✗ ${err.name}: ${err.error}`);
    }
  }
  console.log();
}

function isArchivePath(path: string): boolean {
  return path.endsWith(".tar.gz") || path.endsWith(".tgz") || path.endsWith(".zip");
}

/**
 * Run the agent import command.
 *
 * @param source - Path to an Agent Companies directory/archive/manifest source
 * @param options - Command options
 */
export async function runAgentImport(
  source: string,
  options?: {
    dryRun?: boolean;
    skipExisting?: boolean;
    project?: string;
  },
): Promise<void> {
  const dryRun = options?.dryRun ?? false;
  const skipExisting = options?.skipExisting ?? false;

  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) {
    console.error(`Path not found: ${sourcePath}`);
    process.exit(1);
  }

  // Get existing agent names for skip logic
  const projectPath = await getProjectPath(options?.project);
  const agentStore = new AgentStore({ rootDir: projectPath + "/.fusion" });
  await agentStore.init();

  const existingAgents = await agentStore.listAgents();
  const existingNames = new Set(existingAgents.map((a) => a.name));
  const conversionOptions = {
    ...(skipExisting ? { skipExisting: [...existingNames] } : {}),
    existingAgents,
  };

  let companyName: string | undefined;
  let companySlug: string | undefined;
  let agentCount = 0;
  let teamCount = 0;
  let importItems: Array<{
    manifestKey: string;
    input: AgentCreateInput;
    reportsTo?: {
      raw: string;
      resolvedAgentId?: string;
      deferredManifestKey?: string;
    };
  }> = [];
  let result: {
    created: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  } = {
    created: [],
    skipped: [],
    errors: [],
  };
  let skills: SkillManifest[] = [];
  let isPackageImport = false;

  try {
    const sourceStats = statSync(sourcePath);

    if (sourceStats.isDirectory()) {
      const pkg = parseCompanyDirectory(sourcePath);
      companyName = pkg.company?.name;
      companySlug = pkg.company?.slug;
      agentCount = pkg.agents.length;
      teamCount = pkg.teams.length;
      skills = pkg.skills ?? [];
      isPackageImport = true;
      ({ items: importItems, result } = prepareAgentCompaniesImport(pkg, conversionOptions));
    } else if (isArchivePath(sourcePath)) {
      const pkg = await parseCompanyArchive(sourcePath);
      companyName = pkg.company?.name;
      companySlug = pkg.company?.slug;
      agentCount = pkg.agents.length;
      teamCount = pkg.teams.length;
      skills = pkg.skills ?? [];
      isPackageImport = true;
      ({ items: importItems, result } = prepareAgentCompaniesImport(pkg, conversionOptions));
    } else if (sourcePath.endsWith(".md")) {
      const content = readFileSync(sourcePath, "utf-8");
      const { manifest } = parseSingleAgentManifest(content);
      const pkg = {
        company: undefined,
        agents: [manifest],
        teams: [],
        projects: [],
        tasks: [],
      };
      agentCount = pkg.agents.length;
      teamCount = 0;
      skills = [];
      isPackageImport = false;
      ({ items: importItems, result } = prepareAgentCompaniesImport(pkg, conversionOptions));
    } else {
      throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
    }
  } catch (err) {
    if (err instanceof AgentCompaniesParseError) {
      console.error(`Parse error: ${err.message}`);
      process.exit(1);
    }

    if (err instanceof Error && err.message === UNSUPPORTED_FORMAT_MESSAGE) {
      console.error(err.message);
      process.exit(1);
    }

    console.error(`Error reading source: ${(err as Error).message}`);
    process.exit(1);
  }

  if (result.created.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log();
    console.log("  No agents found in manifest");
    console.log();
    return;
  }

  // Dry run: just preview (includes skill preview for package imports)
  if (dryRun) {
    const skillResult = isPackageImport
      ? await importSkillsToProject(projectPath, skills, companySlug, true)
      : undefined;
    printSummary(companyName, agentCount, teamCount, result.created, result.skipped, result.errors, true, skillResult);
    return;
  }

  // Create agents
  const created: string[] = [];
  const errors: Array<{ name: string; error: string }> = [...result.errors];
  const createdAgentIdsByManifestKey = new Map<string, string>();

  for (const item of importItems) {
    try {
      // Double-check for duplicates if not using skipExisting
      if (!skipExisting && existingNames.has(item.input.name)) {
        errors.push({ name: item.input.name, error: "Agent with this name already exists" });
        continue;
      }

      const input: AgentCreateInput = {
        ...item.input,
        ...(item.input.metadata ? { metadata: { ...item.input.metadata } } : {}),
      };

      if (item.reportsTo?.deferredManifestKey) {
        const resolvedReportsTo = createdAgentIdsByManifestKey.get(item.reportsTo.deferredManifestKey);
        if (!resolvedReportsTo) {
          errors.push({
            name: item.input.name,
            error: `Could not resolve reportsTo reference "${item.reportsTo.raw}" because the manager was not created`,
          });
          continue;
        }
        input.reportsTo = resolvedReportsTo;
      } else if (item.reportsTo?.resolvedAgentId) {
        input.reportsTo = item.reportsTo.resolvedAgentId;
      }

      const agent = await agentStore.createAgent(input);
      created.push(input.name);
      createdAgentIdsByManifestKey.set(item.manifestKey, agent.id);
    } catch (err) {
      errors.push({ name: item.input.name, error: (err as Error).message });
    }
  }

  // Import skills for package imports (directory/archive)
  const skillResult = isPackageImport && skills.length > 0
    ? await importSkillsToProject(projectPath, skills, companySlug, false)
    : undefined;

  printSummary(companyName, agentCount, teamCount, created, result.skipped, errors, false, skillResult);
}
