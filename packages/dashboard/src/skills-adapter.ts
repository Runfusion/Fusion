/**
 * Skills runtime adapter for fn dashboard.
 *
 * Provides skills discovery, execution toggling, and catalog fetching capabilities
 * by integrating with the pi-coding-agent package manager and skills.sh API.
 */

import { access, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

/**
 * Check if a path exists asynchronously using access().
 * Preferred over existsSync() to avoid blocking the Node event loop.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal interface matching pi-coding-agent's PathMetadata.
 * Duplicated here to avoid direct dependency on the pi-coding-agent package in the dashboard.
 */
interface PathMetadata {
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

/**
 * Minimal interface matching pi-coding-agent's ResolvedResource.
 * Duplicated here to avoid direct dependency on the pi-coding-agent package in the dashboard.
 */
interface ResolvedResource {
  path: string;
  enabled: boolean;
  metadata: PathMetadata;
}

/**
 * Discovered skill with computed metadata.
 */
export interface DiscoveredSkill {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  enabled: boolean;
  metadata: {
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

/**
 * Catalog entry from skills.sh.
 */
export interface CatalogEntry {
  id: string;
  slug: string;
  name: string;
  description?: string;
  repo?: string;
  npmPackage?: string;
  tags?: string[];
  installs?: number;
  installation: {
    installed: boolean;
    matchingSkillIds: string[];
    matchingPaths: string[];
  };
}

/**
 * Result of fetching the skills catalog.
 */
export interface CatalogFetchResult {
  entries: CatalogEntry[];
  auth: {
    mode: "authenticated" | "unauthenticated" | "fallback-unauthenticated";
    tokenPresent: boolean;
    fallbackUsed: boolean;
  };
}

/**
 * Toggle execution skill result.
 */
export interface ToggleSkillResult {
  settingsPath: "skills" | "packages[].skills";
  pattern: string;
  targetFile: string;
}

/**
 * A file entry in a skill directory.
 */
export interface SkillFileEntry {
  name: string;
  relativePath: string;
  type: "file" | "directory";
}

/**
 * Content of a skill including its SKILL.md and supplementary files.
 */
export interface SkillContent {
  name: string;
  skillMd: string;
  files: SkillFileEntry[];
}

/**
 * Upstream error codes for catalog fetch failures.
 */
export type UpstreamErrorCode = "upstream_timeout" | "upstream_http_error" | "upstream_invalid_payload";

/**
 * Upstream error with code.
 */
export interface UpstreamError {
  error: string;
  code: UpstreamErrorCode;
}

/**
 * Skills adapter interface exposed via ServerOptions.
 */
export interface SkillsAdapter {
  /**
   * Discover all skills available in the project.
   * Combines top-level skills and package-scoped skills.
   */
  discoverSkills(rootDir: string): Promise<DiscoveredSkill[]>;

  /**
   * Toggle a skill's enabled/disabled state.
   * Updates project settings and returns persistence info.
   */
  toggleExecutionSkill(
    rootDir: string,
    input: { skillId: string; enabled: boolean },
  ): Promise<ToggleSkillResult>;

  /**
   * Fetch the skills.sh catalog with optional authentication.
   */
  fetchCatalog(input: { limit: number; query?: string }): Promise<CatalogFetchResult | UpstreamError>;

  /**
   * Read the contents of a skill's SKILL.md file and list supplementary files.
   */
  readSkillContent(rootDir: string, skillId: string): Promise<SkillContent>;
}

/**
 * Compute deterministic skill ID from metadata.
 * Format: encodeURIComponent(metadata.source) + "::" + relativePath
 *
 * @param source - The package source identifier
 * @param relativePath - Path relative to the skill directory
 * @returns Deterministic skill ID
 */
export function computeSkillId(source: string, relativePath: string): string {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return `${encodeURIComponent(source)}::${normalizedPath}`;
}

/**
 * Parse a skill ID back into source and relativePath components.
 */
export function parseSkillId(skillId: string): { source: string; relativePath: string } | null {
  const parts = skillId.split("::");
  if (parts.length !== 2) return null;
  try {
    return {
      source: decodeURIComponent(parts[0]!),
      relativePath: parts[1]!,
    };
  } catch {
    return null;
  }
}

/**
 * Check if a skill path is enabled in the settings.
 * Checks both top-level skills and package-scoped skills.
 */
function isSkillEnabled(
  skillId: string,
  settings: { skills?: string[]; packages?: Array<{ source: string; skills?: string[] }> },
): boolean {
  // Check top-level skills
  const skills = settings.skills ?? [];
  for (const entry of skills) {
    const entryPath = entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
    const entryId = computeSkillId("*", entryPath);
    if (entryId === skillId) {
      return entry.startsWith("+");
    }
  }

  // Check package-scoped skills
  const packages = settings.packages ?? [];
  for (const pkg of packages) {
    const source = typeof pkg === "string" ? pkg : pkg.source;
    const pkgSkills = typeof pkg === "object" ? pkg.skills : undefined;
    if (!pkgSkills) continue;

    for (const entry of pkgSkills) {
      const entryPath = entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
      const entryId = computeSkillId(source, entryPath);
      if (entryId === skillId) {
        return entry.startsWith("+");
      }
    }
  }

  // Default to disabled if not found
  return false;
}

/**
 * Create the skills adapter implementation.
 */
export function createSkillsAdapter(options: {
  /** Package manager for skill resolution */
  packageManager: {
    resolve(onMissing?: (source: string) => Promise<unknown>): Promise<{
      skills: ResolvedResource[];
      [key: string]: ResolvedResource[];
    }>;
  };
  /** Project settings path helper */
  getSettingsPath: (rootDir: string) => string;
}): SkillsAdapter {
  return {
    async discoverSkills(rootDir: string): Promise<DiscoveredSkill[]> {
      // Resolve all resources including skills
      const resolved = await options.packageManager.resolve();
      const skillResources = resolved.skills ?? [];

      // Load current settings to check enabled state
      const settingsPath = options.getSettingsPath(rootDir);
      let settings: { skills?: string[]; packages?: unknown[] } = {};
      if (await pathExists(settingsPath)) {
        try {
          settings = JSON.parse(await readFile(settingsPath, "utf-8")) as typeof settings;
        } catch {
          // Ignore parse errors
        }
      }

      const discoveredSkills: DiscoveredSkill[] = [];

      for (const resource of skillResources) {
        // Compute relative path for the skill
        const skillRelativePath = "skills/" + relative(resource.metadata.baseDir ?? "", resource.path);

        const skillId = computeSkillId(resource.metadata.source, skillRelativePath);
        const skillName = extractSkillName(skillRelativePath, resource.metadata.source);

        discoveredSkills.push({
          id: skillId,
          name: skillName,
          path: resource.path,
          relativePath: skillRelativePath,
          enabled: isSkillEnabled(skillId, settings as Parameters<typeof isSkillEnabled>[1]),
          metadata: {
            source: resource.metadata.source,
            scope: resource.metadata.scope,
            origin: resource.metadata.origin,
            baseDir: resource.metadata.baseDir,
          },
        });
      }

      return discoveredSkills;
    },

    async toggleExecutionSkill(
      rootDir: string,
      input: { skillId: string; enabled: boolean },
    ): Promise<ToggleSkillResult> {
      const { skillId, enabled } = input;
      const parsed = parseSkillId(skillId);
      if (!parsed) {
        throw new Error(`Invalid skill ID format: ${skillId}`);
      }

      const { source, relativePath } = parsed;

      // Validate that the skill exists in discovered skills
      const discovered = await this.discoverSkills(rootDir);
      const skillExists = discovered.some((s) => s.id === skillId);
      if (!skillExists) {
        throw new Error(`Skill not found: ${skillId}`);
      }

      // Load settings
      const settingsPath = options.getSettingsPath(rootDir);
      const settingsDir = dirname(settingsPath);
      if (!await pathExists(settingsDir)) {
        await mkdir(settingsDir, { recursive: true });
      }

      let settings: Record<string, unknown> = {};
      if (await pathExists(settingsPath)) {
        try {
          settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
        } catch {
          // Start fresh on parse error
        }
      }

      // Ensure skills and packages arrays exist
      if (!Array.isArray(settings.skills)) {
        settings.skills = [];
      }
      if (!Array.isArray(settings.packages)) {
        settings.packages = [];
      }

      const isTopLevel = source === "*";
      const skillPath = relativePath.replace(/^skills\//, "");

      if (isTopLevel) {
        // Toggle in top-level skills
        const skills = settings.skills as string[];
        const prefix = enabled ? "+" : "-";

        // Remove any existing entry for this path (both + and -)
        const existingIdx = skills.findIndex((s) => {
          const p = s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
          return p === skillPath;
        });
        if (existingIdx !== -1) {
          skills.splice(existingIdx, 1);
        }

        // Add the new entry
        skills.push(`${prefix}${skillPath}`);

        settings.skills = skills;

        await writeFile(settingsPath, JSON.stringify(settings, null, 2));
        return {
          settingsPath: "skills",
          pattern: `${prefix}${skillPath}`,
          targetFile: settingsPath,
        };
      } else {
        // Toggle in package-scoped skills
        const packages = settings.packages as Array<{ source: string; skills?: string[] }>;
        const prefix = enabled ? "+" : "-";

        // Find or create the package entry
        let pkgEntry = packages.find((p) => {
          const pkgSource = typeof p === "string" ? p : p.source;
          return pkgSource === source;
        });

        if (!pkgEntry) {
          // Create new package entry as object
          pkgEntry = { source, skills: [] };
          packages.push(pkgEntry);
        } else if (typeof pkgEntry === "string") {
          // Convert string entry to object, preserving the source string value
          const idx = packages.indexOf(pkgEntry);
          pkgEntry = { source, skills: [] };
          packages[idx] = pkgEntry;
        } else {
          // pkgEntry is already an object - ensure skills array exists
          // and preserve other fields like extensions, prompts, themes
          if (!Array.isArray(pkgEntry.skills)) {
            pkgEntry.skills = [];
          }
        }

        // Ensure skills array exists
        if (!Array.isArray(pkgEntry.skills)) {
          pkgEntry.skills = [];
        }

        // Remove any existing entry for this path
        const existingIdx = pkgEntry.skills.findIndex((s) => {
          const p = s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
          return p === skillPath;
        });
        if (existingIdx !== -1) {
          pkgEntry.skills.splice(existingIdx, 1);
        }

        // Add the new entry
        pkgEntry.skills.push(`${prefix}${skillPath}`);

        settings.packages = packages;
        await writeFile(settingsPath, JSON.stringify(settings, null, 2));
        return {
          settingsPath: "packages[].skills",
          pattern: `${prefix}${skillPath}`,
          targetFile: settingsPath,
        };
      }
    },

    async fetchCatalog(input: { limit: number; query?: string }): Promise<CatalogFetchResult | UpstreamError> {
      const { limit, query } = input;
      const boundedLimit = Math.min(Math.max(1, limit), 100);

      // Get skills.sh token if available
      const token = process.env.SKILLS_SH_TOKEN;
      const catalogUrl = buildCatalogUrl(boundedLimit, query);
      const searchUrl = buildSearchUrl(boundedLimit, query);

      // No token available - use public search endpoint
      if (!token) {
        return fetchPublicCatalog(searchUrl, {
          mode: "unauthenticated",
          tokenPresent: false,
          fallbackUsed: false,
        });
      }

      // Try authenticated v1 catalog endpoint first
      try {
        const authResponse = await fetch(catalogUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (authResponse.ok) {
          const data = await authResponse.json().catch(() => null);
          if (data) {
            return normalizeCatalogResponse(data, false);
          }

          return {
            error: "Invalid upstream response format",
            code: "upstream_invalid_payload",
          };
        }

        // 400/401/403 from authenticated request - fall back to public search endpoint
        if (authResponse.status === 400 || authResponse.status === 401 || authResponse.status === 403) {
          return fetchPublicCatalog(searchUrl, {
            mode: "fallback-unauthenticated",
            tokenPresent: true,
            fallbackUsed: true,
          });
        }

        // Upstream error
        return {
          error: `Upstream returned ${authResponse.status}: ${authResponse.statusText}`,
          code: "upstream_http_error",
        };
      } catch (err) {
        const error = err as Error;
        if (isTimeoutError(error)) {
          return { error: "Upstream request timed out", code: "upstream_timeout" };
        }
        return {
          error: error.message || "Upstream request failed",
          code: "upstream_http_error",
        };
      }
    },

    async readSkillContent(rootDir: string, skillId: string): Promise<SkillContent> {
      const parsed = parseSkillId(skillId);
      if (!parsed) {
        throw new Error(`Invalid skill ID format: ${skillId}`);
      }

      const discovered = await this.discoverSkills(rootDir);
      const skill = discovered.find((entry) => entry.id === skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }

      let skillDir = skill.path;
      try {
        const skillPathStat = await stat(skill.path);
        skillDir = skillPathStat.isFile() ? dirname(skill.path) : skill.path;
      } catch {
        skillDir = dirname(skill.path);
      }

      const skillMdPath = join(skillDir, "SKILL.md");
      let skillMd = "";
      try {
        skillMd = await readFile(skillMdPath, "utf-8");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }

      const entries = await readdir(skillDir, { withFileTypes: true }).catch(() => []);
      const files: SkillFileEntry[] = entries
        .filter((entry) => entry.name !== "SKILL.md")
        .map((entry) => ({
          name: entry.name,
          relativePath: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));

      return {
        name: skill.name,
        skillMd,
        files,
      };
    },
  };
}

/**
 * Extract skill name from path and source.
 */
function extractSkillName(skillPath: string, source: string): string {
  // Get the last two path components (category/name or just name)
  const parts = skillPath.split("/").filter(Boolean);
  if (parts.length >= 2) {
    // Return last two parts joined
    return parts.slice(-2).join("/");
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  // Fallback to source
  return source;
}

/**
 * Build the authenticated catalog URL.
 */
function buildCatalogUrl(limit: number, query?: string): string {
  const params = new URLSearchParams();
  params.set("limit", String(limit));

  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }

  return `https://skills.sh/api/v1/skills?${params.toString()}`;
}

/**
 * Build the public search URL.
 *
 * The search API requires a non-empty query. For initial catalog browsing,
 * use "*" as a wildcard query.
 */
function buildSearchUrl(limit: number, query?: string): string {
  const params = new URLSearchParams();
  const normalizedQuery = query?.trim();

  params.set("q", normalizedQuery && normalizedQuery.length > 0 ? normalizedQuery : "*");
  params.set("limit", String(limit));

  return `https://skills.sh/api/search?${params.toString()}`;
}

/**
 * Fetch and normalize catalog data from the public /api/search endpoint.
 */
async function fetchPublicCatalog(
  url: string,
  auth: CatalogFetchResult["auth"],
): Promise<CatalogFetchResult | UpstreamError> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        error: `Upstream returned ${response.status}: ${response.statusText}`,
        code: "upstream_http_error",
      };
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      return {
        error: "Invalid upstream response format",
        code: "upstream_invalid_payload",
      };
    }

    return normalizeSearchResponse(data, auth);
  } catch (err) {
    const error = err as Error;
    if (isTimeoutError(error)) {
      return { error: "Upstream request timed out", code: "upstream_timeout" };
    }
    return {
      error: error.message || "Upstream request failed",
      code: "upstream_http_error",
    };
  }
}

/**
 * Normalize public search endpoint response shape to CatalogFetchResult.
 */
function normalizeSearchResponse(
  data: unknown,
  auth: CatalogFetchResult["auth"],
): CatalogFetchResult | UpstreamError {
  if (!data || typeof data !== "object") {
    return {
      error: "Invalid upstream response format",
      code: "upstream_invalid_payload",
    };
  }

  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.skills)) {
    return {
      error: "Invalid upstream response format: expected { skills: [...] }",
      code: "upstream_invalid_payload",
    };
  }

  return {
    entries: record.skills.map(normalizeSearchEntry),
    auth,
  };
}

/**
 * Normalize a single /api/search skill entry to CatalogEntry.
 */
function normalizeSearchEntry(entry: unknown): CatalogEntry {
  if (!entry || typeof entry !== "object") {
    return {
      id: "",
      slug: "",
      name: "Unknown",
      installation: { installed: false, matchingSkillIds: [], matchingPaths: [] },
    };
  }

  const record = entry as Record<string, unknown>;
  const id = String(record.id ?? record.skillId ?? "");
  const nameCandidate = String(record.name ?? record.skillId ?? id);

  return {
    id,
    slug: id,
    name: nameCandidate || "Unknown",
    repo: record.source ? String(record.source) : undefined,
    installs: typeof record.installs === "number" ? record.installs : undefined,
    installation: {
      installed: false,
      matchingSkillIds: [],
      matchingPaths: [],
    },
  };
}

function isTimeoutError(error: Error): boolean {
  const message = error.message?.toLowerCase() ?? "";
  return error.name === "TimeoutError" || message.includes("timeout");
}

/**
 * Normalize catalog response to handle both array and wrapped formats.
 */
function normalizeCatalogResponse(
  data: unknown,
  fallbackUsed: boolean,
): CatalogFetchResult | UpstreamError {
  if (!data || typeof data !== "object") {
    return {
      error: "Invalid upstream response format",
      code: "upstream_invalid_payload",
    };
  }

  // Handle array format
  if (Array.isArray(data)) {
    return {
      entries: data.map(normalizeEntry),
      auth: {
        mode: fallbackUsed ? "fallback-unauthenticated" : "authenticated",
        tokenPresent: !fallbackUsed,
        fallbackUsed,
      },
    };
  }

  // Handle wrapped format { skills: [...] }
  const record = data as Record<string, unknown>;
  const skills = record.skills;
  if (Array.isArray(skills)) {
    return {
      entries: skills.map(normalizeEntry),
      auth: {
        mode: fallbackUsed ? "fallback-unauthenticated" : "authenticated",
        tokenPresent: !fallbackUsed,
        fallbackUsed,
      },
    };
  }

  return {
    error: "Invalid upstream response format: expected array or { skills: [...] }",
    code: "upstream_invalid_payload",
  };
}

/**
 * Normalize a single catalog entry.
 */
function normalizeEntry(entry: unknown): CatalogEntry {
  if (!entry || typeof entry !== "object") {
    return {
      id: "",
      slug: "",
      name: "Unknown",
      installation: { installed: false, matchingSkillIds: [], matchingPaths: [] },
    };
  }

  const record = entry as Record<string, unknown>;
  const id = String(record.id ?? record.slug ?? "");
  const slug = String(record.slug ?? record.name ?? id);
  const name = String(record.name ?? record.title ?? slug);
  const description = record.description ? String(record.description) : undefined;
  const repo = record.repo ? String(record.repo) : undefined;
  const npmPackage = record.npmPackage ? String(record.npmPackage) : undefined;
  const tags = Array.isArray(record.tags) ? record.tags.map(String) : undefined;
  const installs = typeof record.installs === "number" ? record.installs : undefined;

  return {
    id,
    slug,
    name,
    description,
    repo,
    npmPackage,
    tags,
    installs,
    installation: {
      installed: false,
      matchingSkillIds: [],
      matchingPaths: [],
    },
  };
}

/**
 * Read project settings from .fusion/settings.json.
 */
export async function readProjectSettings(projectPath: string): Promise<Record<string, unknown>> {
  const fusionSettings = join(projectPath, ".fusion", "settings.json");

  if (await pathExists(fusionSettings)) {
    try {
      return JSON.parse(await readFile(fusionSettings, "utf-8")) as Record<string, unknown>;
    } catch {
      // Return empty on parse error
    }
  }

  return {};
}

/**
 * Write project settings to .fusion/settings.json atomically.
 */
export async function writeProjectSettings(projectPath: string, settings: Record<string, unknown>): Promise<void> {
  const settingsDir = join(projectPath, ".fusion");
  const settingsPath = join(settingsDir, "settings.json");

  if (!await pathExists(settingsDir)) {
    await mkdir(settingsDir, { recursive: true });
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Get the settings file path for a project.
 */
export function getProjectSettingsPath(rootDir: string): string {
  return join(rootDir, ".fusion", "settings.json");
}
