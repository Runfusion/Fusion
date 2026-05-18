/**
 * Parser for Agent Companies markdown manifests.
 *
 * @module agent-companies-parser
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

import extractZip from "extract-zip";
import { parse as parseYaml } from "yaml";

import type {
  AgentCompaniesImportResult,
  AgentCompaniesPackage,
  AgentManifest,
  CompanyManifest,
  ProjectManifest,
  SkillManifest,
  TaskManifest,
  TeamManifest,
} from "./agent-companies-types.js";
import type { AgentCapability, AgentCreateInput, AgentUpdateInput } from "./types.js";

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

function slugifyAgentReference(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeReference(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePathReference(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const withoutFile = normalized.replace(/\/AGENTS\.md$/i, "").replace(/\.md$/i, "");
  return withoutFile.replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

function extractPathBasename(value: string): string | undefined {
  const normalized = normalizePathReference(value);
  if (!normalized.includes("/")) {
    return undefined;
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1);
}

function looksLikeFusionAgentId(value: string): boolean {
  return /^agent-[a-z0-9-]+$/i.test(value.trim());
}

function pushAlias(aliases: Set<string>, value: string | undefined | null): void {
  if (typeof value !== "string") {
    return;
  }

  const normalized = normalizeReference(value);
  if (normalized.length > 0) {
    aliases.add(normalized);
  }

  const slug = slugifyAgentReference(value);
  if (slug.length > 0) {
    aliases.add(slug);
  }

  const pathRef = normalizePathReference(value);
  if (pathRef !== normalized && pathRef.length > 0) {
    aliases.add(pathRef);
  }

  const basename = extractPathBasename(value);
  if (basename) {
    aliases.add(basename);
    const basenameSlug = slugifyAgentReference(basename);
    if (basenameSlug.length > 0) {
      aliases.add(basenameSlug);
    }
  }
}

function collectAgentManifestAliases(agent: AgentManifest): string[] {
  const aliases = new Set<string>();
  pushAlias(aliases, agent.slug);
  pushAlias(aliases, agent.name);
  pushAlias(aliases, agent.title);
  return [...aliases];
}

function collectExistingAgentAliases(agent: {
  id: string;
  name: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): string[] {
  const aliases = new Set<string>();
  pushAlias(aliases, agent.id);
  pushAlias(aliases, agent.name);
  pushAlias(aliases, agent.title);

  const metadataSlug = agent.metadata?.agentCompaniesSlug;
  if (typeof metadataSlug === "string") {
    pushAlias(aliases, metadataSlug);
  }

  return [...aliases];
}

function addAliases(
  index: Map<string, Set<string>>,
  ownerKey: string,
  aliases: Iterable<string>,
): void {
  for (const alias of aliases) {
    const bucket = index.get(alias) ?? new Set<string>();
    bucket.add(ownerKey);
    index.set(alias, bucket);
  }
}

function resolveUniqueAlias(
  aliasIndex: Map<string, Set<string>>,
  reference: string,
): { value?: string; ambiguous?: true } {
  const aliases = new Set<string>();
  pushAlias(aliases, reference);

  const matches = new Set<string>();
  for (const alias of aliases) {
    for (const match of aliasIndex.get(alias) ?? []) {
      matches.add(match);
    }
  }

  if (matches.size === 1) {
    return { value: [...matches][0] };
  }

  if (matches.size > 1) {
    return { ambiguous: true };
  }

  return {};
}

function createUniqueManifestKey(baseKey: string, usedKeys: Set<string>): string {
  let candidate = baseKey;
  let counter = 2;

  while (usedKeys.has(candidate)) {
    candidate = `${baseKey}#${counter}`;
    counter += 1;
  }

  usedKeys.add(candidate);
  return candidate;
}

function topologicallySortImportPlanItems<T extends PreparedAgentCompaniesImportItem>(
  items: T[],
): {
  orderedItems: T[];
  cycleErrors: Array<{ name: string; error: string }>;
} {
  const byKey = new Map(items.map((item) => [item.manifestKey, item]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const item of items) {
    indegree.set(item.manifestKey, 0);
  }

  for (const item of items) {
    const deferredKey = item.reportsTo?.deferredManifestKey;
    if (!deferredKey || !byKey.has(deferredKey)) {
      continue;
    }

    indegree.set(item.manifestKey, (indegree.get(item.manifestKey) ?? 0) + 1);
    const downstream = dependents.get(deferredKey) ?? [];
    downstream.push(item.manifestKey);
    dependents.set(deferredKey, downstream);
  }

  const ready = items
    .filter((item) => (indegree.get(item.manifestKey) ?? 0) === 0)
    .sort((a, b) => a.index - b.index);
  const orderedItems: T[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) {
      continue;
    }

    orderedItems.push(current);

    for (const dependentKey of dependents.get(current.manifestKey) ?? []) {
      const nextDegree = (indegree.get(dependentKey) ?? 0) - 1;
      indegree.set(dependentKey, nextDegree);
      if (nextDegree === 0) {
        const dependent = byKey.get(dependentKey);
        if (dependent) {
          ready.push(dependent);
          ready.sort((a, b) => a.index - b.index);
        }
      }
    }
  }

  const cycleErrors = items
    .filter((item) => !orderedItems.some((ordered) => ordered.manifestKey === item.manifestKey))
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      name: item.input.name ?? "(unknown)",
      error: `Could not resolve reportsTo hierarchy for ${item.input.name ?? "(unknown)"} because the import graph contains a cycle involving "${item.reportsTo?.raw ?? "unknown"}"`,
    }));

  return { orderedItems, cycleErrors };
}

export interface PreparedAgentCompaniesImportItem {
  manifestKey: string;
  aliases: string[];
  input: AgentCreateInput | AgentUpdateInput;
  index: number;
  mode: "create" | "update";
  existingAgentId?: string;
  reportsTo?: {
    raw: string;
    resolvedAgentId?: string;
    deferredManifestKey?: string;
  };
}

export interface PreparedAgentCompaniesImportResult {
  items: PreparedAgentCompaniesImportItem[];
  result: AgentCompaniesImportResult;
}

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

export function parseSkillManifest(content: string): SkillManifest {
  const { frontmatter, body } = parseYamlFrontmatter(content);
  requireName(frontmatter, "skill");
  return {
    ...(frontmatter as unknown as SkillManifest),
    instructionBody: body,
  };
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
    skills: parseManifestSubdirectories(resolvedPath, "skills", "SKILL.md", parseSkillManifest),
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
    return resolveExtractionRoot(join(tempDir, directories[0].name));
  }

  return tempDir;
}

async function extractTarArchive(archivePath: string, outputDir: string): Promise<void> {
  const [{ execFile }, { promisify }] = await Promise.all([
    import("node:child_process"),
    import("node:util"),
  ]);
  const execFileAsync = promisify(execFile);
  await execFileAsync("tar", ["xzf", archivePath, "-C", outputDir]);
}

function sanitizeCompanySubPath(subPath: string): string {
  const trimmed = subPath.trim();
  if (trimmed.length === 0) {
    throw new AgentCompaniesParseError("subPath must not be empty");
  }
  if (trimmed.includes("\\")) {
    throw new AgentCompaniesParseError(`Invalid subPath "${subPath}": backslashes are not allowed`);
  }
  if (isAbsolute(trimmed)) {
    throw new AgentCompaniesParseError(`Invalid subPath "${subPath}": absolute paths are not allowed`);
  }

  const normalized = normalize(trimmed).replace(/^\/+/, "");
  if (normalized === "" || normalized === "." || normalized.split("/").some((segment) => segment === "..")) {
    throw new AgentCompaniesParseError(`Invalid subPath "${subPath}": path traversal is not allowed`);
  }

  return normalized;
}

function findArchiveWrapperRoot(tempDir: string): string {
  const directories = readdirSync(tempDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  if (directories.length === 1) {
    return join(tempDir, directories[0].name);
  }

  return tempDir;
}

export async function parseCompanyArchive(
  archivePath: string,
  options?: { subPath?: string },
): Promise<AgentCompaniesPackage> {
  const resolvedArchivePath = resolve(archivePath);
  const tempDir = mkdtempSync(join(tmpdir(), "agent-companies-"));

  try {
    if (resolvedArchivePath.endsWith(".tar.gz") || resolvedArchivePath.endsWith(".tgz")) {
      await extractTarArchive(resolvedArchivePath, tempDir);
    } else if (resolvedArchivePath.endsWith(".zip")) {
      await extractZip(resolvedArchivePath, { dir: tempDir });
    } else {
      throw new AgentCompaniesParseError(
        "Unsupported archive format. Expected .tar.gz, .tgz, or .zip",
      );
    }

    if (typeof options?.subPath === "string") {
      const wrapperRoot = findArchiveWrapperRoot(tempDir);
      const sanitizedSubPath = sanitizeCompanySubPath(options.subPath);
      const candidateRoot = join(wrapperRoot, sanitizedSubPath);
      const companyManifestPath = join(candidateRoot, "COMPANY.md");
      if (!existsSync(companyManifestPath)) {
        throw new AgentCompaniesParseError(
          `Company manifest not found at archive subPath "${sanitizedSubPath}" (expected ${companyManifestPath})`,
        );
      }
      return parseCompanyDirectory(candidateRoot);
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
  if (typeof agent.slug === "string" && agent.slug.trim().length > 0) {
    metadata.agentCompaniesSlug = agent.slug.trim();
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
    ...(typeof agent.memory === "string" && agent.memory.trim().length > 0
      ? { memory: agent.memory.trim() }
      : {}),
    ...(typeof agent.soul === "string" && agent.soul.trim().length > 0
      ? { soul: agent.soul.trim() }
      : {}),
    ...(typeof agent.personality === "string" && agent.personality.trim().length > 0
      ? { soul: agent.personality.trim() }
      : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function agentManifestToAgentUpdateInput(agent: AgentManifest): AgentUpdateInput {
  const metadata: Record<string, unknown> = {};

  if (Array.isArray(agent.skills) && agent.skills.length > 0) {
    metadata.skills = agent.skills;
  }
  if (Array.isArray(agent.metadata?.sources) && agent.metadata.sources.length > 0) {
    metadata.sources = agent.metadata.sources;
  }
  if (typeof agent.slug === "string" && agent.slug.trim().length > 0) {
    metadata.agentCompaniesSlug = agent.slug.trim();
  }

  const updates: AgentUpdateInput = {};

  if (typeof agent.name === "string" && agent.name.trim().length > 0) {
    updates.name = agent.name.trim();
  }
  if (typeof agent.role === "string" && agent.role.trim().length > 0) {
    updates.role = mapRoleToCapability(agent.role);
  }
  if (typeof agent.title === "string" && agent.title.trim().length > 0) {
    updates.title = agent.title.trim();
  }
  if (typeof agent.icon === "string" && agent.icon.trim().length > 0) {
    updates.icon = agent.icon.trim();
  }
  if (typeof agent.reportsTo === "string" && agent.reportsTo.trim().length > 0) {
    updates.reportsTo = agent.reportsTo.trim();
  }
  if (typeof agent.instructionBody === "string" && agent.instructionBody.trim().length > 0) {
    updates.instructionsText = agent.instructionBody.trim();
  }
  if (typeof agent.memory === "string" && agent.memory.trim().length > 0) {
    updates.memory = agent.memory.trim();
  }
  if (typeof agent.soul === "string" && agent.soul.trim().length > 0) {
    updates.soul = agent.soul.trim();
  }
  if (typeof agent.personality === "string" && agent.personality.trim().length > 0) {
    updates.soul = agent.personality.trim();
  }
  if (Object.keys(metadata).length > 0) {
    updates.metadata = metadata;
  }

  return updates;
}

/**
 * Find an existing agent that matches a manifest by name or alias.
 * Returns the matched agent id, or undefined if no match.
 */
export function findExistingAgentIdByManifest(
  manifest: AgentManifest,
  existingAgents: Array<{
    id: string;
    name: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }>,
): { id: string; ambiguous?: false } | { ambiguous: true } | undefined {
  const manifestAliases = new Set(collectAgentManifestAliases(manifest));
  const matches = new Set<string>();

  for (const agent of existingAgents) {
    const agentAliases = new Set(collectExistingAgentAliases(agent));
    for (const alias of manifestAliases) {
      if (agentAliases.has(alias)) {
        matches.add(agent.id);
        break;
      }
    }
  }

  if (matches.size === 1) {
    return { id: [...matches][0] };
  }
  if (matches.size > 1) {
    return { ambiguous: true };
  }
  return undefined;
}

export function prepareAgentCompaniesImport(
  pkg: AgentCompaniesPackage,
  options?: {
    skipExisting?: string[];
    updateExisting?: boolean;
    existingAgents?: Array<{
      id: string;
      name: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }>;
  },
): PreparedAgentCompaniesImportResult {
  const existingNames = new Set(options?.skipExisting ?? []);
  const updateExisting = options?.updateExisting ?? false;
  const existingAliasIndex = new Map<string, Set<string>>();
  const existingAgentsById = new Map(
    (options?.existingAgents ?? []).map((agent) => [agent.id, agent]),
  );

  for (const agent of options?.existingAgents ?? []) {
    addAliases(existingAliasIndex, agent.id, collectExistingAgentAliases(agent));
  }

  const plannedAgents: Array<PreparedAgentCompaniesImportItem & { manifest: AgentManifest }> = [];
  const pendingAgents: Array<PreparedAgentCompaniesImportItem & { manifest: AgentManifest }> = [];
  const manifestAliasIndex = new Map<string, Set<string>>();
  const usedManifestKeys = new Set<string>();
  const result: AgentCompaniesImportResult = {
    created: [],
    updated: [],
    skipped: [],
    errors: [],
  };

  for (const [index, agent] of pkg.agents.entries()) {
    if (existingNames.has(agent.name)) {
      result.skipped.push(agent.name);
      continue;
    }

    // When updateExisting is enabled, try to match an existing agent by alias
    let existingMatch: { id: string } | { ambiguous: true } | undefined;
    if (updateExisting) {
      existingMatch = findExistingAgentIdByManifest(agent, options?.existingAgents ?? []);
      if (existingMatch && "ambiguous" in existingMatch) {
        result.errors.push({
          name: agent.name,
          error: `Manifest "${agent.name}" matches multiple existing agents; cannot determine which to update`,
        });
        continue;
      }
    }

    const aliases = collectAgentManifestAliases(agent);
    const baseKey = aliases[0] ?? createUniqueManifestKey(`agent-${index + 1}`, usedManifestKeys);
    const manifestKey = createUniqueManifestKey(baseKey, usedManifestKeys);

    const planned: PreparedAgentCompaniesImportItem & { manifest: AgentManifest } = {
      manifest: agent,
      manifestKey,
      aliases,
      input: existingMatch && "id" in existingMatch
        ? agentManifestToAgentUpdateInput(agent)
        : agentManifestToAgentCreateInput(agent),
      index,
      mode: existingMatch && "id" in existingMatch ? "update" : "create",
      ...(existingMatch && "id" in existingMatch
        ? { existingAgentId: existingMatch.id }
        : {}),
    };

    addAliases(manifestAliasIndex, manifestKey, aliases);
    plannedAgents.push(planned);
  }

  for (const planned of plannedAgents) {
    // For updates, preserve existing reportsTo unless manifest explicitly overrides it
    if (planned.mode === "update") {
      const rawReportsTo = typeof planned.manifest.reportsTo === "string"
        ? planned.manifest.reportsTo.trim()
        : undefined;

      if (!rawReportsTo) {
        delete planned.input.reportsTo;
        pendingAgents.push(planned);
        continue;
      }

      const existingManagerMatch = resolveUniqueAlias(existingAliasIndex, rawReportsTo);
      if (existingManagerMatch.ambiguous) {
        result.errors.push({
          name: planned.input.name ?? planned.manifest.name,
          error: `reportsTo reference "${rawReportsTo}" is ambiguous among existing Fusion agents`,
        });
        continue;
      }
      if (existingManagerMatch.value) {
        planned.input.reportsTo = existingManagerMatch.value;
        planned.reportsTo = {
          raw: rawReportsTo,
          resolvedAgentId: existingManagerMatch.value,
        };
        result.updated.push(planned.manifest.name);
        pendingAgents.push(planned);
        continue;
      }

      const manifestManagerMatch = resolveUniqueAlias(manifestAliasIndex, rawReportsTo);
      if (manifestManagerMatch.ambiguous) {
        result.errors.push({
          name: planned.input.name ?? planned.manifest.name,
          error: `reportsTo reference "${rawReportsTo}" matches multiple imported agents`,
        });
        continue;
      }
      if (manifestManagerMatch.value) {
        if (manifestManagerMatch.value === planned.manifestKey) {
          result.errors.push({
            name: planned.input.name ?? planned.manifest.name,
            error: `reportsTo reference "${rawReportsTo}" resolves to the agent itself`,
          });
          continue;
        }

        delete planned.input.reportsTo;
        planned.reportsTo = {
          raw: rawReportsTo,
          deferredManifestKey: manifestManagerMatch.value,
        };
        result.updated.push(planned.manifest.name);
        pendingAgents.push(planned);
        continue;
      }

      if (looksLikeFusionAgentId(rawReportsTo) && !existingAgentsById.has(rawReportsTo)) {
        planned.input.reportsTo = rawReportsTo;
        planned.reportsTo = {
          raw: rawReportsTo,
          resolvedAgentId: rawReportsTo,
        };
        result.updated.push(planned.manifest.name);
        pendingAgents.push(planned);
        continue;
      }

      result.errors.push({
        name: planned.input.name ?? planned.manifest.name,
        error: `Could not resolve reportsTo reference "${rawReportsTo}" to an imported or existing Fusion agent`,
      });
      continue;
    }

    // Create mode: original reportsTo resolution logic
    const rawReportsTo = typeof planned.manifest.reportsTo === "string"
      ? planned.manifest.reportsTo.trim()
      : undefined;

    if (!rawReportsTo) {
      delete planned.input.reportsTo;
      result.created.push(planned.input.name ?? planned.manifest.name);
      pendingAgents.push(planned);
      continue;
    }

    const existingMatch = resolveUniqueAlias(existingAliasIndex, rawReportsTo);
    if (existingMatch.ambiguous) {
      result.errors.push({
        name: planned.input.name ?? planned.manifest.name,
        error: `reportsTo reference "${rawReportsTo}" is ambiguous among existing Fusion agents`,
      });
      continue;
    }
    if (existingMatch.value) {
      planned.input.reportsTo = existingMatch.value;
      planned.reportsTo = {
        raw: rawReportsTo,
        resolvedAgentId: existingMatch.value,
      };
      result.created.push(planned.input.name ?? planned.manifest.name);
      pendingAgents.push(planned);
      continue;
    }

    const manifestMatch = resolveUniqueAlias(manifestAliasIndex, rawReportsTo);
    if (manifestMatch.ambiguous) {
      result.errors.push({
        name: planned.input.name ?? planned.manifest.name,
        error: `reportsTo reference "${rawReportsTo}" matches multiple imported agents`,
      });
      continue;
    }
    if (manifestMatch.value) {
      if (manifestMatch.value === planned.manifestKey) {
        result.errors.push({
          name: planned.input.name ?? planned.manifest.name,
          error: `reportsTo reference "${rawReportsTo}" resolves to the agent itself`,
        });
        continue;
      }

      delete planned.input.reportsTo;
      planned.reportsTo = {
        raw: rawReportsTo,
        deferredManifestKey: manifestMatch.value,
      };
      result.created.push(planned.input.name ?? planned.manifest.name);
      pendingAgents.push(planned);
      continue;
    }

    if (looksLikeFusionAgentId(rawReportsTo) && !existingAgentsById.has(rawReportsTo)) {
      planned.input.reportsTo = rawReportsTo;
      planned.reportsTo = {
        raw: rawReportsTo,
        resolvedAgentId: rawReportsTo,
      };
      result.created.push(planned.input.name ?? planned.manifest.name);
      pendingAgents.push(planned);
      continue;
    }

    result.errors.push({
      name: planned.input.name ?? planned.manifest.name,
      error: `Could not resolve reportsTo reference "${rawReportsTo}" to an imported or existing Fusion agent`,
    });
  }

  const { orderedItems, cycleErrors } = topologicallySortImportPlanItems(pendingAgents);
  for (const error of cycleErrors) {
    result.errors.push(error);
    result.created = result.created.filter((name) => name !== error.name);
    result.updated = result.updated.filter((name) => name !== error.name);
  }

  return {
    items: orderedItems.map(({ manifest: _manifest, ...item }) => item),
    result,
  };
}

export function convertAgentCompanies(
  pkg: AgentCompaniesPackage,
  options?: {
    skipExisting?: string[];
    updateExisting?: boolean;
    existingAgents?: Array<{
      id: string;
      name: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }>;
  },
): { inputs: AgentCreateInput[]; result: AgentCompaniesImportResult } {
  const { items, result } = prepareAgentCompaniesImport(pkg, options);
  return {
    inputs: items.filter((item) => item.mode === "create").map((item) => item.input as AgentCreateInput),
    result,
  };
}
