/**
 * Parser for Agent Companies markdown manifests.
 *
 * @module agent-companies-parser
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import extractZip from "extract-zip";
import { parse as parseYaml } from "yaml";

import type {
  AgentCompaniesImportResult,
  AgentCompaniesPackage,
  AgentManifest,
  CompanyManifest,
  ProjectManifest,
  TaskManifest,
  TeamManifest,
} from "./agent-companies-types.js";
import type { AgentCapability, AgentCreateInput } from "./types.js";

export class AgentCompaniesParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCompaniesParseError";
  }
}

const VALID_ROLES: Set<string> = new Set([
  "triage",
  "executor",
  "reviewer",
  "merger",
  "scheduler",
  "engineer",
  "custom",
]);

/**
 * Map a role string to a Fusion agent capability.
 * Unknown roles fall back to "custom".
 */
export function mapRoleToCapability(role: string): AgentCapability {
  if (VALID_ROLES.has(role)) {
    return role as AgentCapability;
  }
  return "custom";
}

export function parseYamlFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new AgentCompaniesParseError("Manifest content is empty or not a string");
  }

  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new AgentCompaniesParseError("Missing YAML frontmatter delimiters (---)");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (error) {
    throw new AgentCompaniesParseError(
      `Malformed YAML frontmatter: ${(error as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentCompaniesParseError("YAML frontmatter must parse to an object");
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

function requireName(frontmatter: Record<string, unknown>, kind: string): void {
  if (typeof frontmatter.name !== "string" || frontmatter.name.trim().length === 0) {
    throw new AgentCompaniesParseError(`${kind} manifest is missing required field: name`);
  }
}

function parseTypedManifest<T>(content: string, kind: string): T {
  const { frontmatter } = parseYamlFrontmatter(content);
  requireName(frontmatter, kind);
  return frontmatter as T;
}

export function parseAgentManifest(content: string): AgentManifest {
  const { frontmatter, body } = parseYamlFrontmatter(content);
  requireName(frontmatter, "agent");
  return {
    ...(frontmatter as unknown as AgentManifest),
    instructionBody: body,
  };
}

export function parseSingleAgentManifest(content: string): { manifest: AgentManifest } {
  return { manifest: parseAgentManifest(content) };
}

export function parseCompanyManifest(content: string): CompanyManifest {
  return parseTypedManifest<CompanyManifest>(content, "company");
}

export function parseTeamManifest(content: string): TeamManifest {
  return parseTypedManifest<TeamManifest>(content, "team");
}

export function parseProjectManifest(content: string): ProjectManifest {
  return parseTypedManifest<ProjectManifest>(content, "project");
}

export function parseTaskManifest(content: string): TaskManifest {
  return parseTypedManifest<TaskManifest>(content, "task");
}

function parseManifestFile<T>(filePath: string, parser: (content: string) => T): T {
  try {
    return parser(readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (error instanceof AgentCompaniesParseError) {
      throw new AgentCompaniesParseError(`${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function parseManifestSubdirectories<T>(
  rootDir: string,
  sectionDir: string,
  filename: string,
  parser: (content: string) => T,
): T[] {
  const sectionPath = join(rootDir, sectionDir);
  if (!existsSync(sectionPath)) {
    return [];
  }

  const manifests: T[] = [];
  const entries = readdirSync(sectionPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const manifestPath = join(sectionPath, entry.name, filename);
    if (!existsSync(manifestPath)) {
      continue;
    }
    manifests.push(parseManifestFile(manifestPath, parser));
  }

  return manifests;
}

function walkTeamIncludes(teams: TeamManifest[]): void {
  const byKey = new Map<string, TeamManifest>();
  for (const team of teams) {
    const key = team.slug ?? team.name;
    byKey.set(key, team);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (key: string, depth = 0): void => {
    if (depth > 64 || visited.has(key) || visiting.has(key)) {
      return;
    }

    visiting.add(key);
    const team = byKey.get(key);
    if (team?.includes) {
      for (const includeRef of team.includes) {
        const includeKey = includeRef.replace(/\.md$/i, "").split("/").pop();
        if (includeKey) {
          visit(includeKey, depth + 1);
        }
      }
    }

    visiting.delete(key);
    visited.add(key);
  };

  for (const key of byKey.keys()) {
    visit(key);
  }
}

export function parseCompanyDirectory(dirPath: string): AgentCompaniesPackage {
  const resolvedPath = resolve(dirPath);
  if (!existsSync(resolvedPath)) {
    throw new AgentCompaniesParseError(`Company directory does not exist: ${resolvedPath}`);
  }
  if (!statSync(resolvedPath).isDirectory()) {
    throw new AgentCompaniesParseError(`Company path is not a directory: ${resolvedPath}`);
  }

  const companyPath = join(resolvedPath, "COMPANY.md");
  const teams = parseManifestSubdirectories(resolvedPath, "teams", "TEAM.md", parseTeamManifest);
  walkTeamIncludes(teams);

  return {
    company: existsSync(companyPath)
      ? parseManifestFile(companyPath, parseCompanyManifest)
      : undefined,
    agents: parseManifestSubdirectories(resolvedPath, "agents", "AGENTS.md", parseAgentManifest),
    teams,
    projects: parseManifestSubdirectories(
      resolvedPath,
      "projects",
      "PROJECT.md",
      parseProjectManifest,
    ),
    tasks: parseManifestSubdirectories(resolvedPath, "tasks", "TASK.md", parseTaskManifest),
  };
}

function resolveExtractionRoot(tempDir: string): string {
  if (existsSync(join(tempDir, "COMPANY.md"))) {
    return tempDir;
  }

  const directories = readdirSync(tempDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  for (const directory of directories) {
    const candidate = join(tempDir, directory.name);
    if (existsSync(join(candidate, "COMPANY.md"))) {
      return candidate;
    }
  }

  if (directories.length === 1) {
    return join(tempDir, directories[0].name);
  }

  return tempDir;
}

export async function parseCompanyArchive(archivePath: string): Promise<AgentCompaniesPackage> {
  const resolvedArchivePath = resolve(archivePath);
  const tempDir = mkdtempSync(join(tmpdir(), "agent-companies-"));

  try {
    if (resolvedArchivePath.endsWith(".tar.gz") || resolvedArchivePath.endsWith(".tgz")) {
      execSync(
        `tar xzf ${JSON.stringify(resolvedArchivePath)} -C ${JSON.stringify(tempDir)}`,
        { stdio: "pipe" },
      );
    } else if (resolvedArchivePath.endsWith(".zip")) {
      await extractZip(resolvedArchivePath, { dir: tempDir });
    } else {
      throw new AgentCompaniesParseError(
        "Unsupported archive format. Expected .tar.gz, .tgz, or .zip",
      );
    }

    return parseCompanyDirectory(resolveExtractionRoot(tempDir));
  } catch (error) {
    if (error instanceof AgentCompaniesParseError) {
      throw error;
    }

    throw new AgentCompaniesParseError(
      `Failed to parse Agent Companies archive: ${(error as Error).message}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function agentManifestToAgentCreateInput(agent: AgentManifest): AgentCreateInput {
  const metadata: Record<string, unknown> = {};

  // Store skills and metadata sources in metadata (skills is not a first-class field)
  if (Array.isArray(agent.skills) && agent.skills.length > 0) {
    metadata.skills = agent.skills;
  }
  if (Array.isArray(agent.metadata?.sources) && agent.metadata.sources.length > 0) {
    metadata.sources = agent.metadata.sources;
  }

  return {
    name: agent.name,
    role: agent.role ? mapRoleToCapability(agent.role) : mapRoleToCapability("custom"),
    ...(typeof agent.title === "string" && agent.title.trim().length > 0
      ? { title: agent.title }
      : {}),
    ...(typeof agent.icon === "string" && agent.icon.trim().length > 0
      ? { icon: agent.icon.trim() }
      : {}),
    ...(typeof agent.reportsTo === "string" && agent.reportsTo.trim().length > 0
      ? { reportsTo: agent.reportsTo.trim() }
      : {}),
    ...(typeof agent.instructionBody === "string" && agent.instructionBody.trim().length > 0
      ? { instructionsText: agent.instructionBody.trim() }
      : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function convertAgentCompanies(
  pkg: AgentCompaniesPackage,
  options?: { skipExisting?: string[] },
): { inputs: AgentCreateInput[]; result: AgentCompaniesImportResult } {
  const existingNames = new Set(options?.skipExisting ?? []);
  const inputs: AgentCreateInput[] = [];
  const result: AgentCompaniesImportResult = {
    created: [],
    skipped: [],
    errors: [],
  };

  for (const agent of pkg.agents) {
    if (existingNames.has(agent.name)) {
      result.skipped.push(agent.name);
      continue;
    }

    try {
      inputs.push(agentManifestToAgentCreateInput(agent));
      result.created.push(agent.name);
    } catch (error) {
      result.errors.push({
        name: agent.name,
        error: (error as Error).message,
      });
    }
  }

  return { inputs, result };
}
