import { ApiError } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

export function registerAgentSkillsRoutes(ctx: ApiRoutesContext): void {
  const { router, options, getScopedStore, rethrowAsApiError } = ctx;

  /**
   * GET /api/skills/discovered
   * List all discovered skills with their enabled state.
   * Query: projectId (optional) for multi-project context
   * Response: { skills: DiscoveredSkill[] }
   */
  router.get("/skills/discovered", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const rootDir = scopedStore.getRootDir();
      const skills = await skillsAdapter.discoverSkills(rootDir);

      res.json({ skills });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to discover skills");
    }
  });

  /**
   * GET /api/skills/:id/content
   * Read the contents of a skill's SKILL.md file and list supplementary files.
   * Params: id (URL-encoded skill ID)
   * Query: projectId (optional) for multi-project context
   * Response: { content: SkillContent }
   * Error: 404 { error: string; code: "skill_not_found" | "adapter_not_configured" }
   */
  router.get("/skills/:id/content", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      /*
      FNXC:Skills 2026-07-10-00:00:
      Express 5 decodes route params once before this handler runs. Discovery IDs from computeSkillId intentionally keep only the source segment URL-encoded, so pass req.params.id through unchanged; a second decode corrupts plugin/npm/path sources and breaks exact-ID skill content lookup (FN-7777).
      */
      const skillId = req.params.id as string;

      const rootDir = scopedStore.getRootDir();
      const content = await skillsAdapter.readSkillContent(rootDir, skillId);

      res.json({ content });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("Skill not found")) {
        res.status(404).json({ error: "Skill not found", code: "skill_not_found" });
        return;
      }
      if (err instanceof Error && err.message.includes("Invalid skill ID")) {
        res.status(400).json({ error: err.message, code: "invalid_skill_id" });
        return;
      }
      rethrowAsApiError(err, "Failed to read skill content");
    }
  });

  /*
  FNXC:Skills 2026-06-23-04:15:
  GET /api/skills/:id/file — return a single supplementary file's text for the SkillsView detail-pane file viewer. The /content endpoint lists files (name/path/type) but not their bodies; clicking a file in the detail pane needs its content. The skill-dir-relative path arrives URL-encoded in the `path` query param; the adapter resolves + traversal-guards it against the skill directory.
  Params: id (URL-encoded skill ID)
  Query: path (skill-dir-relative file path), projectId (optional)
  Response: { file: SkillFileContent }
  Error: 404 { code: "skill_not_found" | "skill_file_not_found" }, 400 { code: "invalid_skill_id" | "invalid_path" }
  */
  router.get("/skills/:id/file", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      /*
      FNXC:Skills 2026-07-10-00:00:
      Express 5 decodes route params once before this handler runs. Discovery IDs from computeSkillId intentionally keep only the source segment URL-encoded, so pass req.params.id through unchanged; a second decode corrupts plugin/npm/path sources and breaks exact-ID supplementary file lookup (FN-7777).
      */
      const skillId = req.params.id as string;

      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      if (!rawPath.trim()) {
        res.status(400).json({ error: "path is required", code: "invalid_path" });
        return;
      }

      const rootDir = scopedStore.getRootDir();
      const file = await skillsAdapter.readSkillFileContent(rootDir, skillId, rawPath);

      res.json({ file });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("Skill file not found")) {
        res.status(404).json({ error: "Skill file not found", code: "skill_file_not_found" });
        return;
      }
      if (err instanceof Error && err.message.includes("Skill not found")) {
        res.status(404).json({ error: "Skill not found", code: "skill_not_found" });
        return;
      }
      if (err instanceof Error && (err.message.includes("Invalid skill ID") || err.message.includes("Invalid skill file path"))) {
        res.status(400).json({ error: err.message, code: "invalid_path" });
        return;
      }
      rethrowAsApiError(err, "Failed to read skill file");
    }
  });

  /**
   * PATCH /api/skills/execution
   * Toggle a skill's enabled/disabled state.
   * Body: { skillId: string; enabled: boolean }
   * Query: projectId (optional) for multi-project context
   * Response: { success: true; skillId: string; enabled: boolean; persistence: { scope: "project"; targetFile: string; settingsPath: string; pattern: string } }
   */
  router.patch("/skills/execution", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const { skillId, enabled } = req.body as { skillId?: string; enabled?: boolean };

      if (!skillId || typeof skillId !== "string") {
        res.status(400).json({ error: "skillId is required", code: "invalid_body" });
        return;
      }

      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean", code: "invalid_body" });
        return;
      }

      const rootDir = scopedStore.getRootDir();
      const persistence = await skillsAdapter.toggleExecutionSkill(rootDir, { skillId, enabled });

      res.json({
        success: true,
        skillId,
        enabled,
        persistence: {
          scope: "project",
          targetFile: persistence.targetFile,
          settingsPath: persistence.settingsPath,
          pattern: persistence.pattern,
        },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes("Invalid skill ID")) {
        res.status(400).json({ error: err.message, code: "invalid_skill_id" });
        return;
      }
      if (err instanceof Error && err.message.includes("Skill not found")) {
        res.status(404).json({ error: err.message, code: "skill_not_found" });
        return;
      }
      rethrowAsApiError(err, "Failed to toggle skill execution");
    }
  });

  /**
   * POST /api/skills/install
   * Install a catalog skill via the shared skills.sh installer.
   * Body: { source: string; skill?: string }
   * Query: projectId (optional) for multi-project context
   * Response: { success: true }
   * Error: 400 { error: string; code: "invalid_body"|"invalid_source" }
   * Error: 502 { error: string; code: "spawn_error"|"install_failed"|"install_timeout" }
   */
  router.post("/skills/install", async (req, res) => {
    try {
      const scopedStore = await getScopedStore(req);
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const { source, skill } = req.body as { source?: string; skill?: string };
      if (typeof source !== "string" || !source.trim()) {
        res.status(400).json({ error: "source is required", code: "invalid_body" });
        return;
      }

      const normalizedSource = source.trim();
      if (!/^[^/]+\/[^/]+$/.test(normalizedSource)) {
        res.status(400).json({ error: "Invalid source format. Use owner/repo.", code: "invalid_source" });
        return;
      }

      const result = await skillsAdapter.installSkill({
        source: normalizedSource,
        skill: typeof skill === "string" ? skill : undefined,
        cwd: scopedStore.getRootDir(),
      });

      if ("code" in result) {
        res.status(502).json(result);
        return;
      }

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to install skill");
    }
  });

  /**
   * GET /api/skills/catalog
   * Fetch the skills.sh catalog with optional authentication.
   * Query:
   *   - limit: number (default 20, max 100)
   *   - q: optional search query
   *   - projectId (optional) for multi-project context
   * Response: { entries: CatalogEntry[]; auth: { mode: string; tokenPresent: boolean; fallbackUsed: boolean } }
   * Error: 502 { error: string; code: "upstream_timeout"|"upstream_http_error"|"upstream_invalid_payload" }
   */
  router.get("/skills/catalog", async (req, res) => {
    try {
      const skillsAdapter = options?.skillsAdapter;

      if (!skillsAdapter) {
        res.status(404).json({ error: "Skills adapter not configured", code: "adapter_not_configured" });
        return;
      }

      const limitStr = typeof req.query.limit === "string" ? req.query.limit : "20";
      const limit = Math.min(Math.max(1, parseInt(limitStr, 10) || 20), 100);
      const query = typeof req.query.q === "string" ? req.query.q : undefined;

      const result = await skillsAdapter.fetchCatalog({ limit, query });

      // Check if result is an upstream error
      if ("code" in result) {
        res.status(502).json(result);
        return;
      }

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch skills catalog");
    }
  });

}
