import { createWriteStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { listEligibleExecutorAgents } from "@fusion/engine";
import { ApiError, badRequest, notFound, rateLimited } from "../api-error.js";
import { createSessionDiagnostics } from "../ai-session-diagnostics.js";
import { writeSSEEvent } from "../sse-buffer.js";
import {
  startAgentGeneration,
  generateAgentSpec,
  getAgentGenerationSession,
  cleanupAgentGenerationSession,
  RateLimitError as AgentGenerationRateLimitError,
  SessionNotFoundError as AgentGenerationSessionNotFoundError,
} from "../agent-generation.js";
import type { ApiRoutesContext } from "./types.js";

const { mkdtemp, access, stat, mkdir, rm, writeFile: fsWriteFile } = fsPromises;

export function registerAgentImportExportRoutes(ctx: ApiRoutesContext): void {
  const { router, runtimeLogger, getProjectContext, rethrowAsApiError } = ctx;

  /**
   * POST /api/agents/export
   * Export agents to an Agent Companies package directory.
   *
   * Body:
   *  - { agentIds?: string[]; companyName?: string; companySlug?: string; outputDir?: string }
   */
  router.post("/agents/export", async (req, res) => {
    try {
      const { agentIds, companyName, companySlug, outputDir } = req.body ?? {};

      if (agentIds !== undefined) {
        if (!Array.isArray(agentIds)) {
          throw badRequest("agentIds must be an array of strings");
        }
        if (agentIds.some((id: unknown) => typeof id !== "string" || id.trim().length === 0)) {
          throw badRequest("agentIds must contain non-empty strings");
        }
      }

      if (companyName !== undefined && typeof companyName !== "string") {
        throw badRequest("companyName must be a string");
      }
      if (companySlug !== undefined && typeof companySlug !== "string") {
        throw badRequest("companySlug must be a string");
      }
      if (outputDir !== undefined && typeof outputDir !== "string") {
        throw badRequest("outputDir must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, exportAgentsToDirectory } = await import("@fusion/core");

      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const allAgents = await agentStore.listAgents();
      const requestedIds = Array.isArray(agentIds) ? [...new Set(agentIds.map((id) => id.trim()))] : [];
      const agentsToExport = requestedIds.length > 0
        ? allAgents.filter((agent) => requestedIds.includes(agent.id))
        : allAgents;

      if (agentsToExport.length === 0) {
        throw badRequest("No agents found to export");
      }

      let resolvedOutputDir: string;
      if (typeof outputDir === "string" && outputDir.trim().length > 0) {
        resolvedOutputDir = resolve(outputDir.trim());
      } else if (typeof outputDir === "string") {
        throw badRequest("outputDir cannot be empty");
      } else {
        resolvedOutputDir = await mkdtemp(join(tmpdir(), "fusion-agent-export-"));
      }

      const result = await exportAgentsToDirectory(agentsToExport, resolvedOutputDir, {
        companyName: typeof companyName === "string" ? companyName : undefined,
        companySlug: typeof companySlug === "string" ? companySlug : undefined,
      });

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * Companies.sh company entry from the catalog API.
   */
  interface CompaniesShCompany {
    slug: string;
    name: string;
    tagline?: string;
    repo?: string;
    website?: string;
    installs?: number;
  }

  /**
   * Validate a company slug from companies.sh.
   * Slugs must be lowercase alphanumeric with hyphens, 1-50 chars.
   */
  function isValidCompanySlug(slug: unknown): slug is string {
    if (typeof slug !== "string") return false;
    return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
  }

  function parseCompanyWebsiteSubPath(
    website: string | undefined,
    expectedRepo: string,
  ): { branch?: string; subPath?: string } | null {
    if (typeof website !== "string" || website.trim().length === 0) {
      return null;
    }

    const repoMatch = expectedRepo.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (!repoMatch) {
      return null;
    }

    let url: URL;
    try {
      url = new URL(website);
    } catch {
      return null;
    }

    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 5 || segments[2] !== "tree") {
      return null;
    }

    const [, expectedOwner, expectedRepoName] = repoMatch;
    const [owner, repoName, , branch, ...subPathParts] = segments;
    if (owner !== expectedOwner || repoName !== expectedRepoName) {
      return null;
    }

    const subPath = subPathParts.join("/").trim();
    return {
      branch: typeof branch === "string" && branch.length > 0 ? branch : undefined,
      subPath: subPath.length > 0 ? subPath : undefined,
    };
  }

  /**
   * GET /api/agents/companies
   * Browse companies from companies.sh catalog.
   * Returns normalized company entries for UI display.
   */
  router.get("/agents/companies", async (_req, res) => {
    try {
      const COMPANIES_SH_API = "https://companies.sh/api/companies";

      let companies: CompaniesShCompany[] = [];

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(COMPANIES_SH_API, {
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "fn-dashboard/1.0",
          },
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`companies.sh API returned ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          throw new Error(`companies.sh API returned non-JSON content: ${contentType}`);
        }

        const data = await response.json() as unknown;

        // Handle array response directly
        if (Array.isArray(data)) {
          companies = data.map((item): CompaniesShCompany | null => {
            if (typeof item !== "object" || item === null) return null;
            const entry = item as Record<string, unknown>;
            const slug = typeof entry.slug === "string" ? entry.slug : undefined;
            const name = typeof entry.name === "string" ? entry.name : undefined;

            // Skip entries without required fields or with invalid slugs
            if (!slug || !name || !isValidCompanySlug(slug)) return null;

            return {
              slug,
              name,
              tagline: typeof entry.tagline === "string" ? entry.tagline : undefined,
              repo: typeof entry.repo === "string" ? entry.repo : undefined,
              website: typeof entry.website === "string" ? entry.website : undefined,
              installs: typeof entry.installs === "number" ? entry.installs
                : typeof entry.installs === "string" ? parseInt(entry.installs, 10) || undefined
                : undefined,
            };
          }).filter((c): c is CompaniesShCompany => c !== null);
        } else if (typeof data === "object" && data !== null) {
          // Handle wrapped response: { items: [...] }, { companies: [...] }, or { data: [...] }
          const obj = data as Record<string, unknown>;
          const arr = Array.isArray(obj.items) ? obj.items
            : Array.isArray(obj.companies) ? obj.companies
            : Array.isArray(obj.data) ? obj.data
            : [];

          companies = (arr as unknown[]).map((item): CompaniesShCompany | null => {
            if (typeof item !== "object" || item === null) return null;
            const entry = item as Record<string, unknown>;
            const slug = typeof entry.slug === "string" ? entry.slug : undefined;
            const name = typeof entry.name === "string" ? entry.name : undefined;

            if (!slug || !name || !isValidCompanySlug(slug)) return null;

            return {
              slug,
              name,
              tagline: typeof entry.tagline === "string" ? entry.tagline : undefined,
              repo: typeof entry.repo === "string" ? entry.repo : undefined,
              website: typeof entry.website === "string" ? entry.website : undefined,
              installs: typeof entry.installs === "number" ? entry.installs
                : typeof entry.installs === "string" ? parseInt(entry.installs, 10) || undefined
                : undefined,
            };
          }).filter((c): c is CompaniesShCompany => c !== null);
        }
      } catch (fetchErr) {
        // Return empty array + error message on network/parsing errors
        const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (message.includes("aborted")) {
          throw new Error("companies.sh request timed out");
        }
        // Log and include error in response so frontend can display it
        runtimeLogger.child("agents/companies").warn(`Failed to fetch catalog: ${message}`);
        res.json({ companies, error: `Failed to fetch companies.sh catalog: ${message}` });
        return;
      }

      res.json({ companies });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // ── Agent Import Skill Persistence Helpers ─────────────────────────────────

/**
 * Slugify a string for safe use in filesystem paths.
 * Removes dangerous characters, normalizes whitespace/unicode, limits to alphanumeric + hyphens.
 */
function slugifyPathSegment(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : fallback;
}

/**
 * Generate YAML frontmatter + markdown body string.
 */
function toSkillMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return `---\n${lines.join("\n")}\n---\n${body}`;
}

interface SkillImportResult {
  imported: Array<{ name: string; path: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

interface SkillManifestForImport {
  name?: unknown;
  description?: unknown;
  slug?: unknown;
  schema?: unknown;
  kind?: unknown;
  version?: unknown;
  license?: unknown;
  authors?: unknown;
  tags?: unknown;
  instructionBody?: unknown;
}

/**
 * Persist skill manifests from an Agent Companies package to the project skills directory.
 * Skills are written to: {projectRoot}/skills/imported/{companySlug}/{skillSlug}/SKILL.md
 *
 * Collision handling: if a SKILL.md already exists, the skill is skipped (not overwritten).
 * Path safety: all segments are slugified to prevent directory traversal attacks.
 */
async function persistImportedSkills(
  projectRoot: string,
  skills: SkillManifestForImport[],
  companySlug: string | undefined,
): Promise<SkillImportResult> {
  const result: SkillImportResult = {
    imported: [],
    skipped: [],
    errors: [],
  };

  if (!skills || skills.length === 0) {
    return result;
  }

  // Slugify company slug for directory safety
  const safeCompanySlug = companySlug
    ? slugifyPathSegment(companySlug, "unknown-company")
    : "unknown-company";

  const skillsBaseDir = join(projectRoot, "skills", "imported", safeCompanySlug);

  const usedSlugs = new Set<string>();

  for (const skill of skills) {
    const name = typeof skill.name === "string" && skill.name.trim().length > 0
      ? skill.name.trim()
      : null;

    if (!name) {
      result.errors.push({ name: String(skill.name ?? "?"), error: "Skill missing valid name" });
      continue;
    }

    // Generate unique slug
    let skillSlug = slugifyPathSegment(name, "unnamed-skill");
    if (usedSlugs.has(skillSlug)) {
      let counter = 2;
      while (usedSlugs.has(`${skillSlug}-${counter}`)) {
        counter++;
      }
      skillSlug = `${skillSlug}-${counter}`;
    }
    usedSlugs.add(skillSlug);

    const skillDir = join(skillsBaseDir, skillSlug);
    const skillPath = join(skillDir, "SKILL.md");

    // Check for collision
    try {
      await access(skillPath);
      // File exists, skip
      result.skipped.push(name);
      continue;
    } catch {
      // File doesn't exist, proceed
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      name,
      schema: "agentcompanies/v1",
      kind: "skill",
    };

    if (typeof skill.description === "string" && skill.description.trim()) {
      frontmatter.description = skill.description.trim();
    }
    if (typeof skill.slug === "string" && skill.slug.trim()) {
      frontmatter.slug = skill.slug.trim();
    }
    if (typeof skill.version === "string" && skill.version.trim()) {
      frontmatter.version = skill.version.trim();
    }
    if (typeof skill.license === "string" && skill.license.trim()) {
      frontmatter.license = skill.license.trim();
    }
    if (Array.isArray(skill.authors)) {
      const validAuthors = skill.authors.filter((a): a is string => typeof a === "string");
      if (validAuthors.length > 0) frontmatter.authors = validAuthors;
    }
    if (Array.isArray(skill.tags)) {
      const validTags = skill.tags.filter((t): t is string => typeof t === "string");
      if (validTags.length > 0) frontmatter.tags = validTags;
    }

    // Build body from instructionBody
    const body = typeof skill.instructionBody === "string"
      ? skill.instructionBody
      : `# ${name}\n\n<!-- Add skill instructions here. -->`;

    try {
      await mkdir(skillDir, { recursive: true });
      const content = toSkillMarkdown(frontmatter, body);
      await fsWriteFile(skillPath, content, "utf-8");
      result.imported.push({ name, path: `skills/imported/${safeCompanySlug}/${skillSlug}/SKILL.md` });
    } catch (err) {
      result.errors.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

  /**
   * POST /api/agents/import
   * Import agents from Agent Companies sources.
   *
   * Body modes (checked in order):
   *  - { importSource: "companies.sh", companySlug: string, skipExisting?, dryRun? }
   *  - { agents: AgentManifest[], skipExisting?, dryRun? }
   *  - { source: string, skipExisting?, dryRun? }   // server directory path
   *  - { manifest: string, skipExisting?, dryRun? } // raw AGENTS.md content
   */
  router.post("/agents/import", async (req, res) => {
    try {
      const {
        agents,
        source,
        manifest,
        importSource,
        companySlug: importCompanySlug,
        selectedAgents,
        selectedSkills,
        skipExisting,
        dryRun,
      } = req.body ?? {};
      const {
        AgentStore,
        parseCompanyDirectory,
        parseCompanyArchive,
        parseSingleAgentManifest,
        prepareAgentCompaniesImport,
        AgentCompaniesParseError: _AgentCompaniesParseError,
      } = await import("@fusion/core");

      const { store: scopedStore } = await getProjectContext(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const existingAgents = await agentStore.listAgents();
      const existingNames = new Set(existingAgents.map((a) => a.name));
      const conversionOptions = {
        ...(skipExisting ? { skipExisting: [...existingNames] } : {}),
        existingAgents,
      };

      let pkg: {
        company?: { name?: string; slug?: string };
        agents: unknown[];
        teams: unknown[];
        projects: unknown[];
        tasks: unknown[];
        skills?: unknown[];
      };

      if (Array.isArray(agents)) {
        pkg = {
          company: undefined,
          agents,
          teams: [],
          projects: [],
          tasks: [],
        };
      } else if (typeof source === "string" && source.trim()) {
        const sourcePath = resolve(source);

        const isArchive = sourcePath.endsWith(".tar.gz")
          || sourcePath.endsWith(".tgz")
          || sourcePath.endsWith(".zip");

        if (isArchive) {
          try {
            await stat(sourcePath);
          } catch {
            throw badRequest(`source does not exist: ${sourcePath}`);
          }
          pkg = await parseCompanyArchive(sourcePath);
        } else {
          let sourceStat: import("node:fs").Stats;
          try {
            sourceStat = await stat(sourcePath);
          } catch {
            throw badRequest(`source does not exist: ${sourcePath}`);
          }
          if (sourceStat.isDirectory()) {
            pkg = parseCompanyDirectory(sourcePath);
          } else {
            throw badRequest("Source must be a server-side directory or archive path");
          }
        }
      } else if (typeof manifest === "string") {
        const { manifest: singleAgent } = parseSingleAgentManifest(manifest);
        pkg = {
          company: undefined,
          agents: [singleAgent],
          teams: [],
          projects: [],
          tasks: [],
        };
      } else if (importSource === "companies.sh" && typeof importCompanySlug === "string") {
        // Import from companies.sh catalog
        if (!isValidCompanySlug(importCompanySlug)) {
          throw badRequest(`Invalid companies.sh slug: "${importCompanySlug}". Slugs must be lowercase alphanumeric with hyphens.`);
        }

        // Fetch company info from companies.sh catalog API
        // Note: The per-company endpoint (/api/companies/:slug) returns HTML (SPA),
        // so we fetch the full list and filter by slug.
        const companyApiUrl = "https://companies.sh/api/companies";
        let companyInfo: { name: string; repo?: string; tagline?: string; website?: string } | null = null;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);

          const response = await fetch(companyApiUrl, {
            signal: controller.signal,
            headers: {
              "Accept": "application/json",
              "User-Agent": "fn-dashboard/1.0",
            },
          });

          clearTimeout(timeout);

          if (!response.ok) {
            throw new Error(`companies.sh API returned ${response.status}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json")) {
            throw new Error("companies.sh API returned non-JSON content");
          }

          const data = await response.json() as Record<string, unknown>;

          // The API returns { items: [...] } — find the matching company by slug
          const items = Array.isArray(data.items)
            ? data.items as Record<string, unknown>[]
            : Array.isArray(data)
              ? data as Record<string, unknown>[]
              : [];

          const match = items.find((item) => item.slug === importCompanySlug);
          if (!match) {
            throw badRequest(`Company not found: "${importCompanySlug}"`);
          }

          const name = typeof match.name === "string" ? match.name : importCompanySlug;
          const repo = typeof match.repo === "string" ? match.repo : undefined;
          const tagline = typeof match.tagline === "string" ? match.tagline : undefined;
          const website = typeof match.website === "string" ? match.website : undefined;

          companyInfo = { name, repo, tagline, website };
        } catch (fetchErr) {
          const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (fetchErr instanceof ApiError) throw fetchErr;
          if (message.includes("aborted")) {
            throw new Error("companies.sh request timed out");
          }
          throw badRequest(`Failed to fetch company "${importCompanySlug}": ${message}`);
        }

        // Determine download URL from repo
        if (!companyInfo?.repo) {
          throw badRequest(`Company "${importCompanySlug}" has no repository URL`);
        }

        // Parse the repo URL to determine the archive URL
        // Accept HTTPS GitHub URLs: https://github.com/owner/repo or shorthand: owner/repo
        const repoMatch = companyInfo.repo.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
          ?? companyInfo.repo.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
        if (!repoMatch) {
          throw badRequest(`Unsupported repository URL format: ${companyInfo.repo}. Only GitHub HTTPS URLs and owner/repo shorthand are supported.`);
        }

        const [, repoOwner, repoName] = repoMatch;
        const websiteInfo = parseCompanyWebsiteSubPath(companyInfo.website, `${repoOwner}/${repoName}`);
        const preferredBranch = websiteInfo?.branch?.trim() || "main";
        const subPath = websiteInfo?.subPath;
        const archiveUrl = `https://github.com/${repoOwner}/${repoName}/archive/refs/heads/${preferredBranch}.tar.gz`;

        // Download and extract to temp directory
        let tempDir: string | null = null;
        try {
          tempDir = await mkdtemp(join(tmpdir(), `fn-agent-import-${importCompanySlug}-`));

          // Download the archive
          const archivePath = join(tempDir, "archive.tar.gz");

          // Download with 30-second timeout
          const downloadController = new AbortController();
          const downloadTimeout = setTimeout(() => downloadController.abort(), 30000);

          let archiveResponse: globalThis.Response;
          try {
            archiveResponse = await fetch(archiveUrl, { signal: downloadController.signal });
          } finally {
            clearTimeout(downloadTimeout);
          }

          let downloadResponse: globalThis.Response;
          if (archiveResponse.ok) {
            downloadResponse = archiveResponse;
          } else {
            // Try fallback branch (master) with its own timeout
            const fallbackController = new AbortController();
            const fallbackTimeout = setTimeout(() => fallbackController.abort(), 30000);

            try {
              downloadResponse = await fetch(
                `https://github.com/${repoOwner}/${repoName}/archive/refs/heads/master.tar.gz`,
                { signal: fallbackController.signal },
              );
            } finally {
              clearTimeout(fallbackTimeout);
            }
          }

          if (!downloadResponse.ok) {
            throw badRequest(`Failed to download repository archive: ${downloadResponse.status} ${downloadResponse.statusText}`);
          }
          if (!downloadResponse.body) {
            throw new Error("No response body");
          }

          await streamPipeline(
            Readable.fromWeb(downloadResponse.body as import("node:stream/web").ReadableStream),
            createWriteStream(archivePath),
          );

          // Parse the downloaded archive directly to avoid requiring shell tar tools.
          try {
            pkg = await parseCompanyArchive(archivePath, subPath ? { subPath } : undefined);
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.name === "AgentCompaniesParseError" && subPath) {
              throw badRequest(`Failed to import companies.sh slug "${importCompanySlug}" from subpath "${subPath}": ${parseErr.message}`);
            }
            throw parseErr;
          }

          // Override company info if available from API
          if (companyInfo) {
            pkg.company = {
              name: companyInfo.name,
              slug: importCompanySlug,
            };
          }
        } finally {
          // Clean up temp directory
          if (tempDir) {
            try {
              await rm(tempDir, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup
            }
          }
        }
      } else {
        throw badRequest("Provide one of: agents (array), source (path), manifest (string), or importSource + companySlug");
      }

      const normalizeSelectionNames = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value)) return undefined;
        const normalized = value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        return normalized.length > 0 ? normalized : undefined;
      };

      const selectedAgentNameList = normalizeSelectionNames(selectedAgents);
      const selectedSkillNameList = normalizeSelectionNames(selectedSkills);

      if (selectedAgentNameList) {
        const selectedAgentSet = new Set(selectedAgentNameList);
        pkg.agents = pkg.agents.filter((agent) => (
          typeof agent === "object"
          && agent !== null
          && typeof (agent as { name?: unknown }).name === "string"
          && selectedAgentSet.has((agent as { name: string }).name)
        ));
      }

      if (selectedSkillNameList) {
        const selectedSkillSet = new Set(selectedSkillNameList);
        pkg.skills = (pkg.skills ?? []).filter((skill) => (
          typeof skill === "object"
          && skill !== null
          && typeof (skill as { name?: unknown }).name === "string"
          && selectedSkillSet.has((skill as { name: string }).name)
        ));
      }

      const { items: importItems, result } = prepareAgentCompaniesImport(pkg as import("@fusion/core").AgentCompaniesPackage, conversionOptions);
      const companyName = pkg.company?.name ?? "Unknown";
      const companySlug = typeof pkg.company?.slug === "string" ? pkg.company.slug : undefined;
      const selectedSkillsCount = (pkg.skills ?? []).length;

      if (importItems.length === 0 && selectedSkillsCount === 0 && result.errors.length === 0 && result.skipped.length === 0) {
        throw badRequest("No agents or skills found in manifest");
      }

      // Warn when the imported agents can't actually be assigned mission/queue
      // work: catalog ("company") agents land with role "custom", which is never
      // auto-assigned. If none of the imported agents are executors and no
      // executor already exists, missions run by these agents would stall or
      // fail invisibly (issue #1261). Surface this up front, not after the fact.
      const importWarnings: string[] = [];
      const customRoleCount = importItems.filter((item) => item.input.role === "custom").length;
      const importsAnExecutor = importItems.some((item) => item.input.role === "executor");
      if (customRoleCount > 0 && !importsAnExecutor) {
        const existingExecutors = await listEligibleExecutorAgents(agentStore).catch(() => []);
        if (existingExecutors.length === 0) {
          importWarnings.push(
            `${customRoleCount} imported agent(s) have role "custom" and won't be auto-assigned mission or queue work. `
              + `Assign at least one agent the "executor" role, or keep ephemeral agents enabled, before starting a mission.`,
          );
        }
      }

      if (dryRun) {
        const agentPreview = importItems.map((item) => ({
          name: item.input.name,
          role: item.input.role,
          title: typeof item.input.title === "string" ? item.input.title : undefined,
          icon: typeof item.input.icon === "string" ? item.input.icon : undefined,
          reportsTo: item.reportsTo?.resolvedAgentId,
          instructionsText: typeof item.input.instructionsText === "string"
            ? item.input.instructionsText.slice(0, 200) + (item.input.instructionsText.length > 200 ? "..." : "")
            : undefined,
          memory: typeof item.input.memory === "string"
            ? item.input.memory.slice(0, 200) + (item.input.memory.length > 200 ? "..." : "")
            : undefined,
          skills: Array.isArray(item.input.metadata?.skills)
            ? item.input.metadata.skills.filter((skill: unknown): skill is string => typeof skill === "string")
            : undefined,
        }));

        const skillPreview = (pkg.skills ?? [])
          .filter((skill): skill is Record<string, unknown> => typeof skill === "object" && skill !== null)
          .map((skill) => ({
            name: typeof skill.name === "string" && skill.name.length > 0 ? skill.name : "Unnamed Skill",
            description: typeof skill.description === "string" ? skill.description : undefined,
          }));

        res.json({
          dryRun: true,
          companyName,
          ...(companySlug ? { companySlug } : {}),
          agents: agentPreview,
          skills: skillPreview,
          created: result.created,
          skipped: result.skipped,
          errors: result.errors,
          ...(importWarnings.length > 0 ? { warnings: importWarnings } : {}),
        });
        return;
      }

      const created: Array<{ id: string; name: string }> = [];
      const errors: Array<{ name: string; error: string }> = [...result.errors];
      const createdAgentIdsByManifestKey = new Map<string, string>();

      for (const item of importItems) {
        if (!skipExisting && existingNames.has(item.input.name)) {
          errors.push({ name: item.input.name, error: "Agent with this name already exists" });
          continue;
        }

        const input = {
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

        try {
          const agent = await agentStore.createAgent(input);
          created.push({ id: agent.id, name: agent.name });
          createdAgentIdsByManifestKey.set(item.manifestKey, agent.id);
        } catch (err: unknown) {
          if (err instanceof ApiError) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("Agent with name")) {
            if (!result.skipped.includes(item.input.name)) {
              result.skipped.push(item.input.name);
            }
            continue;
          }
          errors.push({ name: item.input.name, error: message });
        }
      }

      // Persist package skills to project skills directory
      const projectRoot = scopedStore.getRootDir();
      const skillImportResult = await persistImportedSkills(
        projectRoot,
        (pkg.skills ?? []) as SkillManifestForImport[],
        companySlug,
      );

      res.json({
        companyName,
        ...(companySlug ? { companySlug } : {}),
        created,
        skipped: result.skipped,
        errors,
        skillsCount: (pkg.skills ?? []).length,
        skills: skillImportResult,
        ...(importWarnings.length > 0 ? { warnings: importWarnings } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AgentCompaniesParseError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      // Handle AbortError from timed-out fetch calls
      if (err instanceof Error && err.name === "AbortError") {
        throw badRequest("Downloading company repository timed out after 30 seconds");
      }
      rethrowAsApiError(err);
    }
  });


}

export function registerAgentGenerationRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;
  const agentGenerationDiagnostics = createSessionDiagnostics("agent-generation");

  router.post("/agents/onboarding/start-streaming", async (req, res) => {
    try {
      const { intent, context, mode, existingAgentConfig, planningModelProvider, planningModelId } = req.body as {
        intent?: string;
        context?: {
          existingAgents?: Array<{ id: string; name: string; role: string }>;
          templates?: Array<{ id: string; label: string; description?: string }>;
          mode?: "create" | "edit";
          existingAgentConfig?: Record<string, unknown>;
        };
        mode?: "create" | "edit";
        existingAgentConfig?: Record<string, unknown>;
        planningModelProvider?: string;
        planningModelId?: string;
      };

      if (!intent || typeof intent !== "string") {
        throw badRequest("intent is required and must be a string");
      }

      const resolvedMode = mode ?? context?.mode ?? "create";
      if (resolvedMode !== "create" && resolvedMode !== "edit") {
        throw badRequest("mode must be 'create' or 'edit'");
      }

      const resolvedExistingAgentConfig = existingAgentConfig ?? context?.existingAgentConfig;

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const { startAgentOnboardingSession } = await import("../agent-onboarding.js");
      const sessionId = await startAgentOnboardingSession(
        ip,
        {
          mode: resolvedMode,
          intent,
          existingAgents: Array.isArray(context?.existingAgents) ? context.existingAgents : [],
          templates: Array.isArray(context?.templates) ? context.templates : [],
          existingAgentConfig: resolvedExistingAgentConfig,
        },
        scopedStore.getRootDir(),
        planningModelProvider,
        planningModelId,
        settings.promptOverrides,
      );

      res.status(201).json({ sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to start agent onboarding session");
    }
  });

  router.get("/agents/onboarding/:sessionId/stream", async (req, res) => {
    const { sessionId } = req.params;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    const { agentOnboardingStreamManager, getAgentOnboardingSession } = await import("../agent-onboarding.js");
    const session = getAgentOnboardingSession(sessionId);
    if (!session) {
      writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
      res.end();
      return;
    }


    if (session.summary) {
      writeSSEEvent(res, "summary", JSON.stringify(session.summary));
      writeSSEEvent(res, "complete", JSON.stringify({}));
      res.end();
      return;
    }

    if (session.currentQuestion) {
      writeSSEEvent(res, "question", JSON.stringify(session.currentQuestion));
    }

    const unsubscribe = agentOnboardingStreamManager.subscribe(sessionId, (event, eventId) => {
      const data = (event as { data?: unknown }).data;
      if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
        unsubscribe();
        return;
      }
      if (event.type === "complete" || event.type === "error") {
        unsubscribe();
        res.end();
      }
    });

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.post("/agents/onboarding/respond", async (req, res) => {
    try {
      const { sessionId, responses } = req.body as { sessionId?: string; responses?: Record<string, unknown> };
      if (!sessionId || typeof sessionId !== "string") throw badRequest("sessionId is required");
      if (!responses || typeof responses !== "object") throw badRequest("responses is required and must be an object");

      const { respondToAgentOnboarding, getAgentOnboardingSummary, getAgentOnboardingSession } = await import("../agent-onboarding.js");
      await respondToAgentOnboarding(sessionId, responses);
      const summary = getAgentOnboardingSummary(sessionId);
      if (summary) {
        res.json({ type: "complete", data: summary });
        return;
      }
      const session = getAgentOnboardingSession(sessionId);
      if (!session?.currentQuestion) throw badRequest("Session did not produce a question");
      res.json({ type: "question", data: session.currentQuestion });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === "SessionNotFoundError") throw notFound(err.message);
      if (err instanceof Error && err.name === "InvalidSessionStateError") throw badRequest(err.message);
      rethrowAsApiError(err, "Failed to process agent onboarding response");
    }
  });

  router.post("/agents/onboarding/:sessionId/retry", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { retryAgentOnboardingSession } = await import("../agent-onboarding.js");
      await retryAgentOnboardingSession(sessionId);
      res.json({ success: true, sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === "SessionNotFoundError") throw notFound(err.message);
      if (err instanceof Error && err.name === "InvalidSessionStateError") throw badRequest(err.message);
      rethrowAsApiError(err, "Failed to retry agent onboarding session");
    }
  });

  router.post("/agents/onboarding/:sessionId/stop", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { stopAgentOnboardingGeneration } = await import("../agent-onboarding.js");
      const stopped = stopAgentOnboardingGeneration(sessionId);
      if (!stopped) throw notFound(`Agent onboarding session ${sessionId} not found or inactive`);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to stop agent onboarding generation");
    }
  });

  router.post("/agents/onboarding/cancel", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      if (!sessionId || typeof sessionId !== "string") throw badRequest("sessionId is required");
      const { cancelAgentOnboardingSession } = await import("../agent-onboarding.js");
      await cancelAgentOnboardingSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === "SessionNotFoundError") throw notFound(err.message);
      rethrowAsApiError(err, "Failed to cancel agent onboarding session");
    }
  });

  /**
   * POST /api/agents/generate/start
   * Start a new agent generation session.
   * Body: { role: string }
   * Response: { sessionId, roleDescription }
   */
  router.post("/agents/generate/start", async (req, res) => {
    try {
      const { role } = req.body as { role?: string };
      if (!role || typeof role !== "string") {
        throw badRequest("role is required and must be a string");
      }

      const trimmedRole = role.trim();
      if (trimmedRole.length === 0) {
        throw badRequest("role must not be empty");
      }
      if (trimmedRole.length > 1000) {
        throw badRequest("role must not exceed 1000 characters");
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const session = await startAgentGeneration(ip, trimmedRole);

      res.status(201).json({
        sessionId: session.id,
        roleDescription: session.roleDescription,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof AgentGenerationRateLimitError) {
        throw rateLimited(err.message);
      }
      agentGenerationDiagnostics.errorFromException("Error starting session", err, {
        operation: "generate-start",
      });
      rethrowAsApiError(err, "Failed to start agent generation session");
    }
  });

  /**
   * POST /api/agents/generate/spec
   * Generate the agent specification for an existing session.
   * Body: { sessionId: string }
   * Response: { spec: AgentGenerationSpec }
   */
  router.post("/agents/generate/spec", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const rootDir = scopedStore.getRootDir();
      const settings = await scopedStore.getSettings();

      const spec = await generateAgentSpec(sessionId, rootDir, settings.promptOverrides);
      res.json({ spec });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof AgentGenerationSessionNotFoundError) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      agentGenerationDiagnostics.errorFromException("Error generating spec", err, {
        operation: "generate-spec",
      });
      rethrowAsApiError(err, "Failed to generate agent specification");
    }
  });

  /**
   * GET /api/agents/generate/:sessionId
   * Get the current state of an agent generation session.
   * Response: { session: AgentGenerationSession }
   */
  router.get("/agents/generate/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = getAgentGenerationSession(sessionId);

      if (!session) {
        throw notFound(`Session ${sessionId} not found or expired`);
      }

      res.json({ session });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * DELETE /api/agents/generate/:sessionId
   * Cancel and clean up an agent generation session.
   * Response: { success: true }
   */
  router.delete("/agents/generate/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      cleanupAgentGenerationSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });


}
