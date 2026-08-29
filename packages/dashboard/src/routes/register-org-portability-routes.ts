import { ApiError, badRequest } from "../api-error.js";
import { resolveRequestActor } from "../request-actor.js";
import type { ApiRoutesContext } from "./types.js";

/**
 * Values that are never safe to return from a portability endpoint. Reference-only
 * `secretRef` values remain portable because they do not contain secret material.
 */
const SECRET_RESPONSE_KEY = /(?:api[_-]?key|token|password|credential|auth|secret)(?!ref$)/i;

function scrubResponseSecrets(value: unknown, key?: string): unknown {
  if (key && SECRET_RESPONSE_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => scrubResponseSecrets(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([entryKey, entryValue]) => {
    const scrubbed = scrubResponseSecrets(entryValue, entryKey);
    return scrubbed === undefined ? [] : [[entryKey, scrubbed]];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Register project-scoped org portability and configuration history endpoints.
 */
export function registerOrgPortabilityRoutes(ctx: ApiRoutesContext): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;

  /*
  FNXC:CommandCenterConfig 2026-07-18-12:00:
  FR-05 requires the dashboard to export a portable organization bundle without
  relying on a CLI handoff. The core assembler scrubs secrets by default; this
  route applies a second response-boundary scrub so no credential value can be
  exposed even if a future core caller accidentally returns one.
  */
  router.post("/org/export", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      // FNXC:CommandCenterConfig 2026-07-18-12:00: FN-8283 exports are intentionally typed at this route boundary until its core branch lands; do not duplicate bundle assembly or secret scrubbing in the dashboard.
      const { AgentStore, RoutineStore, AutomationStore, assembleOrgBundle } = await import("@fusion/core") as unknown as {
        AgentStore: new (options: { rootDir: string; asyncLayer?: unknown }) => { init(): Promise<void> };
        RoutineStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        AutomationStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        assembleOrgBundle: (stores: unknown) => Promise<unknown>;
      };
      const asyncLayer = scopedStore.getAsyncLayer() ?? undefined;
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer });
      await agentStore.init();
      const bundle = await assembleOrgBundle({
        projectRoot: scopedStore.getRootDir(),
        agentStore,
        routineStore: new RoutineStore(scopedStore.getRootDir(), { asyncLayer }),
        automationStore: new AutomationStore(scopedStore.getRootDir(), { asyncLayer }),
        settingsStore: scopedStore,
      });
      res.json({ bundle: scrubResponseSecrets(bundle) });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.post("/org/import", async (req, res) => {
    try {
      const { bundle, dryRun = false, collisionMode } = req.body ?? {};
      if (!isRecord(bundle)) throw badRequest("bundle must be an object");
      if (typeof dryRun !== "boolean") throw badRequest("dryRun must be a boolean");
      if (collisionMode !== undefined && collisionMode !== "skip" && collisionMode !== "suffix") {
        throw badRequest("collisionMode must be 'skip' or 'suffix'");
      }
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, RoutineStore, AutomationStore, materializeOrgBundle } = await import("@fusion/core") as unknown as {
        AgentStore: new (options: { rootDir: string; asyncLayer?: unknown }) => { init(): Promise<void> };
        RoutineStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        AutomationStore: new (rootDir: string, options: { asyncLayer?: unknown }) => unknown;
        materializeOrgBundle: (stores: unknown, bundle: Record<string, unknown>, options: { dryRun: boolean; collisionMode?: "skip" | "suffix" }) => Promise<unknown>;
      };
      const asyncLayer = scopedStore.getAsyncLayer() ?? undefined;
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer });
      await agentStore.init();
      const result = await materializeOrgBundle({
        projectRoot: scopedStore.getRootDir(), agentStore,
        routineStore: new RoutineStore(scopedStore.getRootDir(), { asyncLayer }),
        automationStore: new AutomationStore(scopedStore.getRootDir(), { asyncLayer }),
        settingsStore: scopedStore,
      }, scrubResponseSecrets(bundle) as Record<string, unknown>, { dryRun, collisionMode });
      res.json({ result: scrubResponseSecrets(result), dryRun });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.get("/config/revisions", async (req, res) => {
    try {
      const configKind = req.query.configKind;
      if (configKind !== undefined && configKind !== "project-settings") {
        throw badRequest("configKind must be project-settings");
      }
      const parsePaging = (value: unknown, name: "limit" | "offset") => {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !/^\d+$/.test(value)) throw badRequest(`${name} must be a non-negative integer`);
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || (name === "limit" && (parsed < 1 || parsed > 500)) || (name === "offset" && parsed < 0)) throw badRequest(`${name} is out of range`);
        return parsed;
      };
      const limit = parsePaging(req.query.limit, "limit");
      const offset = parsePaging(req.query.offset, "offset");
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const layer = scopedStore.getAsyncLayer();
      if (!layer) throw badRequest("Configuration history requires the PostgreSQL revision store");
      // FNXC:CommandCenterConfig 2026-07-18-12:00: FN-8282's revision facade is consumed through this narrow compatibility type until the dependency export is merged into this branch.
      const { ConfigurationRevisionStore } = await import("@fusion/core") as unknown as {
        ConfigurationRevisionStore: new (layer: unknown, projectId?: string) => {
          list(kind: "project-settings", target: Record<string, string>, paging?: number | { limit?: number; offset?: number }): Promise<unknown[]>;
          listPage(kind: "project-settings", target: Record<string, string>, paging?: number | { limit?: number; offset?: number }): Promise<{ revisions: unknown[]; hasMore: boolean }>;
        };
      };
      // FNXC:CommandCenterConfig 2026-07-18-12:00: Dashboard history starts with the project settings target because that is the configuration surface rendered beside these controls; rollback remains the core's exact, forward-recorded operation.
      const page = await new ConfigurationRevisionStore(layer, projectId).listPage("project-settings", { projectId: projectId ?? "" }, { limit, offset });
      res.json({ revisions: page.revisions, limit: limit ?? 100, offset: offset ?? 0, hasMore: page.hasMore });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });

  router.post("/config/revisions/:revisionId/rollback", async (req, res) => {
    try {
      const revisionId = req.params.revisionId?.trim();
      if (!revisionId) throw badRequest("revisionId is required");
      const { store: scopedStore } = await getProjectContext(req);
      const revision = await scopedStore.rollbackConfiguration(revisionId, resolveRequestActor(req));
      res.json({ revision });
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      rethrowAsApiError(error);
    }
  });
}
