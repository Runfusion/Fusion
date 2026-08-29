/**
 * CLI-agent adapter settings + autonomy-approval routes (CLI Agent Executor, U15).
 *
 * All routes are daemon-token authed (the standard `/api` middleware — no new
 * auth surface; the approving principal in v1 is the daemon-token holder, the
 * single workspace owner). Routes:
 *
 *   GET  /api/cli-agents                         — adapter descriptors (tier +
 *                                                   capability flags) for the
 *                                                   settings UI + node editor.
 *   GET  /api/cli-agents/settings                — per-adapter launch config
 *                                                   (GlobalSettings.cliAgents).
 *   PUT  /api/cli-agents/settings                — replace one adapter's launch
 *                                                   config (validated at the core
 *                                                   write boundary).
 *   GET  /api/cli-agents/:adapterId/autonomy     — approval state for the project.
 *   POST /api/cli-agents/:adapterId/approve-autonomy — approve elevated autonomy
 *                                                   for the adapter in this
 *                                                   project (idempotent).
 *   POST /api/cli-agents/:adapterId/revoke-autonomy  — revoke approval.
 *
 * The approval is per-PROJECT + per-adapter, stored in project settings
 * (`approvedCliAutonomyAdapters`) and mirrors the raw workflow-CLI-command
 * approval precedent (`approveWorkflowCliCommand`).
 */

import { listCliAdapterDescriptors } from "@fusion/engine";
import { sanitizeCliAgentSettings, CLI_AGENT_ADAPTER_IDS } from "@fusion/core";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

/** Static adapter descriptor list (tier + capability flags). Stable per build. */
const ADAPTER_DESCRIPTORS = listCliAdapterDescriptors();
const KNOWN_ADAPTER_IDS = new Set<string>(CLI_AGENT_ADAPTER_IDS);

export function registerCliAgentSettingsRoutes(ctx: ApiRoutesContext): void {
  const { router, rethrowAsApiError } = ctx;

  // GET /api/cli-agents — adapter catalog (tier labels + capability flags).
  router.get("/cli-agents", async (_req, res) => {
    res.json({ adapters: ADAPTER_DESCRIPTORS });
  });

  // GET /api/cli-agents/settings — the per-adapter launch config map.
  router.get("/cli-agents/settings", async (req, res) => {
    try {
      const store = await ctx.getScopedStore(req);
      const settings = await store.getSettings();
      res.json({ cliAgents: (settings as { cliAgents?: unknown }).cliAgents ?? {} });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // PUT /api/cli-agents/settings — replace ONE adapter's launch config. The body
  // is `{ adapterId, config }`; an empty/invalid config clears the entry. The
  // core write boundary sanitizes (`sanitizeCliAgentsSettings`) so invalid fields
  // are dropped regardless — this route just scopes the merge to one adapter.
  router.put("/cli-agents/settings", async (req, res) => {
    try {
      const store = await ctx.getScopedStore(req);
      const adapterId = String((req.body as { adapterId?: unknown })?.adapterId ?? "").trim();
      if (!adapterId || !KNOWN_ADAPTER_IDS.has(adapterId)) {
        throw badRequest("Unknown or missing adapterId");
      }
      const rawConfig = (req.body as { config?: unknown })?.config;
      const sanitized = sanitizeCliAgentSettings(rawConfig);

      const settings = await store.getSettings();
      const prior = { ...(((settings as { cliAgents?: Record<string, unknown> }).cliAgents) ?? {}) };
      if (sanitized) {
        prior[adapterId] = sanitized;
      } else {
        delete prior[adapterId];
      }
      await store.updateGlobalSettings({ cliAgents: prior } as never);
      res.json({ cliAgents: prior });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // GET /api/cli-agents/:adapterId/autonomy — approval state for this project.
  router.get("/cli-agents/:adapterId/autonomy", async (req, res) => {
    try {
      const { store } = await ctx.getProjectContext(req);
      const adapterId = req.params.adapterId;
      if (!KNOWN_ADAPTER_IDS.has(adapterId)) throw badRequest("Unknown adapterId");
      const approved = await store.isCliAutonomyApproved(adapterId);
      res.json({ adapterId, approved });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/cli-agents/:adapterId/approve-autonomy — grant elevated autonomy
  // for the adapter in this project. Idempotent. Requires an explicit confirm
  // flag in the body so a stray POST cannot grant elevation by accident.
  router.post("/cli-agents/:adapterId/approve-autonomy", async (req, res) => {
    try {
      const { store } = await ctx.getProjectContext(req);
      const adapterId = req.params.adapterId;
      if (!KNOWN_ADAPTER_IDS.has(adapterId)) throw badRequest("Unknown adapterId");
      if ((req.body as { confirm?: unknown })?.confirm !== true) {
        throw badRequest("Elevated autonomy approval requires explicit confirmation (confirm: true)");
      }
      await store.approveCliAutonomy(adapterId);
      res.json({ adapterId, approved: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  // POST /api/cli-agents/:adapterId/revoke-autonomy — revoke approval. Idempotent.
  router.post("/cli-agents/:adapterId/revoke-autonomy", async (req, res) => {
    try {
      const { store } = await ctx.getProjectContext(req);
      const adapterId = req.params.adapterId;
      if (!KNOWN_ADAPTER_IDS.has(adapterId)) throw badRequest("Unknown adapterId");
      await store.revokeCliAutonomy(adapterId);
      res.json({ adapterId, approved: false });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
}
