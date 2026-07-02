import {
  aggregateTokenAnalytics,
  aggregateToolAnalytics,
  aggregateActivityAnalytics,
  aggregateProductivityAnalytics,
  aggregatePluginActivations,
  aggregateTeamAnalytics,
  aggregateWorkflowAnalytics,
  aggregateGithubIssueAnalytics,
  aggregateSignalsAnalytics,
  composeLiveSnapshot,
  LITELLM_PRICING_SOURCE_URL,
  parseLiteLLMPricing,
  type TokenGroupBy,
  type TokenTimeGranularity,
} from "@fusion/core";
import type { Request, Response } from "express";
import { ApiError } from "../api-error.js";
import {
  serializeCsv,
  tokenAnalyticsToTable,
  toolAnalyticsToTable,
  activityAnalyticsToTable,
  productivityAnalyticsToTable,
  workflowAnalyticsToTable,
  githubIssueAnalyticsToTable,
  type CsvTable,
} from "../command-center-csv.js";
import { invalidateAllGlobalSettingsCaches } from "../project-store-resolver.js";
import { listSignalConnectorStatus, resolveConfiguredSignalProviders } from "./register-signal-routes.js";
import type { ApiRouteRegistrar } from "./types.js";

/**
 * Command Center analytics API (U9).
 *
 * Thin HTTP adapters over the Phase-A core aggregators
 * (`{token,tool,activity,productivity}-analytics.ts`) and the U6a live-snapshot
 * composer (`command-center-live.ts`). All metric math lives in `@fusion/core`
 * (KTD2); these handlers only parse the request, resolve the **project-scoped**
 * store, and serialize the aggregator output.
 *
 * Security:
 *  - Every route inherits the dashboard's standard session/auth middleware via
 *    the {@link ApiRouteRegistrar} contract — exactly like `register-usage-routes.ts`.
 *    No analytics endpoint, including `/live`, is unauthenticated; an
 *    unauthenticated request is rejected with 401 by the server-level auth
 *    middleware before reaching these handlers.
 *  - Every endpoint (JSON, CSV, and `/live`) resolves the database through
 *    `getScopedStore(req)` before aggregating, so a project-A caller can never
 *    read project-B data. The `?format=csv` branch (U8) serializes the SAME
 *    already-scoped aggregator output, so the export path has no separate
 *    scoping surface.
 *
 * Robustness:
 *  - Missing or invalid `from`/`to`/`groupBy` query params fall back to a
 *    documented default window (the last {@link DEFAULT_WINDOW_DAYS} days) and a
 *    no-grouping default — never a 500. See {@link resolveRange}.
 */

/** Documented default analytics window when range params are absent/invalid. */
export const DEFAULT_WINDOW_DAYS = 7;

const VALID_GROUP_BY: ReadonlySet<string> = new Set<TokenGroupBy>([
  "model",
  "provider",
  "node",
  "agent",
]);

const VALID_TOKEN_GRANULARITY: ReadonlySet<string> = new Set<TokenTimeGranularity>([
  "hour",
  "day",
  "week",
]);

/** A resolved, always-valid `[from, to]` ISO range. */
export interface ResolvedRange {
  from: string;
  to: string;
  /** True when the caller's params were missing/invalid and the default applied. */
  defaulted: boolean;
}

function isValidIso(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/**
 * Resolve `from`/`to` query params into an always-valid ISO range.
 *
 * FNXC:CommandCenter 2026-06-25-00:00:
 * FN-7019 fixes the picker/server contract: the date picker omits null bounds,
 * so a from-only request means `[from, now]` and a to-only request means
 * `[epoch, to]`. Only a truly empty/invalid range or an ordered-range violation
 * may fall back to the documented default window; otherwise presets collapse to
 * last-7-days and Command Center charts do not change when operators select a
 * different range. `now` is injectable for tests.
 */
export function resolveRange(
  query: Request["query"],
  now: number = Date.now(),
): ResolvedRange {
  const rawFrom = typeof query.from === "string" ? query.from : undefined;
  const rawTo = typeof query.to === "string" ? query.to : undefined;
  const fromMs = rawFrom !== undefined && isValidIso(rawFrom) ? Date.parse(rawFrom) : undefined;
  const toMs = rawTo !== undefined && isValidIso(rawTo) ? Date.parse(rawTo) : undefined;

  if (fromMs !== undefined && toMs !== undefined) {
    if (fromMs <= toMs) {
      return { from: rawFrom as string, to: rawTo as string, defaulted: false };
    }
  } else if (fromMs !== undefined) {
    return { from: rawFrom as string, to: new Date(now).toISOString(), defaulted: false };
  } else if (toMs !== undefined) {
    return { from: new Date(0).toISOString(), to: rawTo as string, defaulted: false };
  }

  const to = new Date(now).toISOString();
  const from = new Date(now - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { from, to, defaulted: true };
}

/** Resolve the `groupBy` query param, ignoring unknown values. */
export function resolveGroupBy(query: Request["query"]): TokenGroupBy | undefined {
  const raw = typeof query.groupBy === "string" ? query.groupBy : undefined;
  return raw !== undefined && VALID_GROUP_BY.has(raw) ? (raw as TokenGroupBy) : undefined;
}

/** Resolve the token-series `granularity` query param, ignoring unknown values. */
export function resolveTokenGranularity(query: Request["query"]): TokenTimeGranularity | undefined {
  const raw = typeof query.granularity === "string" ? query.granularity : undefined;
  return raw !== undefined && VALID_TOKEN_GRANULARITY.has(raw) ? (raw as TokenTimeGranularity) : undefined;
}

/** True when the caller asked for CSV via `?format=csv` (case-insensitive). */
export function wantsCsv(query: Request["query"]): boolean {
  const raw = typeof query.format === "string" ? query.format : undefined;
  return raw !== undefined && raw.toLowerCase() === "csv";
}

/**
 * Stream a {@link CsvTable} as an `attachment` download. Sets the RFC-4180
 * `text/csv` content-type (charset utf-8) and a `Content-Disposition` filename.
 * Always sends a body — a header-only CSV for an empty result, never a 204.
 */
function sendCsv(res: Response, filename: string, table: CsvTable): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(serializeCsv(table));
}

const PRICING_FETCH_TIMEOUT_MS = 10_000;

async function fetchLatestLiteLLMPricing(): Promise<unknown> {
  const response = await fetch(LITELLM_PRICING_SOURCE_URL, {
    signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(
      502,
      `Failed to fetch pricing source: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  return response.json() as Promise<unknown>;
}

export const registerCommandCenterRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getScopedStore, rethrowAsApiError } = ctx;

  /**
   * GET /api/command-center/tokens
   * Token consumption + derived USD cost (U2 + U3) over a date range.
   * Query: from, to (ISO-8601), groupBy (model|provider|node|agent).
   */
  router.get("/command-center/tokens", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      const groupBy = resolveGroupBy(req.query);
      const granularity = resolveTokenGranularity(req.query);
      const settings = await store.getGlobalSettingsStore().getSettings();
      // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
      // Token analytics now runs on the AsyncDataLayer in backend mode; pass the
      // async layer when present, otherwise the sync SQLite handle, and await.
      const result = await aggregateTokenAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
        groupBy,
        granularity,
        now: Date.now(),
        pricingOverrides: settings.modelPricingOverrides,
      });
      if (wantsCsv(req.query)) {
        sendCsv(res, "command-center-tokens.csv", tokenAnalyticsToTable(result));
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate token analytics");
    }
  });

  /**
   * POST /api/command-center/pricing/fetch
   * Fetch + persist user-editable model-pricing overrides from LiteLLM.
   *
   * FNXC:CommandCenter 2026-06-22-00:00:
   * Operators need a one-click refresh from the pinned LiteLLM JSON dataset without adding HTTP to core pricing. Preserve existing overrides on fetch/parse failures and invalidate global settings caches after a successful write so Command Center cost reads use the refreshed rates immediately.
   */
  router.post("/command-center/pricing/fetch", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const json = await fetchLatestLiteLLMPricing();
      const parsed = parseLiteLLMPricing(json);
      if (parsed.count === 0) {
        throw new ApiError(502, "No chat-mode pricing entries found in fetched LiteLLM data");
      }

      const settings = await store.getGlobalSettingsStore().getSettings();
      const fetchedAt = new Date().toISOString();
      await store.updateGlobalSettings({
        modelPricingOverrides: {
          ...(settings.modelPricingOverrides ?? {}),
          ...parsed.overrides,
        },
        modelPricingFetchedAt: fetchedAt,
        modelPricingSource: LITELLM_PRICING_SOURCE_URL,
      });
      invalidateAllGlobalSettingsCaches();

      res.json({ count: parsed.count, fetchedAt, source: LITELLM_PRICING_SOURCE_URL });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to fetch model pricing");
    }
  });

  /**
   * GET /api/command-center/tools
   * Tool-usage counts + autonomy ratio (U2) over a date range.
   */
  router.get("/command-center/tools", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
      // Tool analytics now runs on the AsyncDataLayer in backend mode.
      const result = await aggregateToolAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
      });
      if (wantsCsv(req.query)) {
        sendCsv(res, "command-center-tools.csv", toolAnalyticsToTable(result));
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate tool analytics");
    }
  });

  /**
   * GET /api/command-center/activity
   * Sessions/messages/active-nodes/stickiness (U2) over a date range.
   */
  router.get("/command-center/activity", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      const result = await aggregateActivityAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
      });
      if (wantsCsv(req.query)) {
        sendCsv(res, "command-center-activity.csv", activityAnalyticsToTable(result));
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate activity analytics");
    }
  });

  /**
   * GET /api/command-center/productivity
   * Files/commits/PRs/LOC (U2) over a date range.
   */
  router.get("/command-center/productivity", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
      // Productivity analytics now runs on the AsyncDataLayer in backend mode.
      const result = await aggregateProductivityAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
      });
      if (wantsCsv(req.query)) {
        sendCsv(
          res,
          "command-center-productivity.csv",
          productivityAnalyticsToTable(result),
        );
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate productivity analytics");
    }
  });

  /**
   * POST /api/command-center/productivity/backfill-loc
   * Explicit operator action to backfill historical commit-association LOC stats.
   *
   * FNXC:CommandCenterLocBackfill 2026-06-21-00:00:
   * The LOC backfill must never run during render-time analytics reads. Keep it an authenticated operator POST, resolve the project-scoped store before invoking the git-backed store method, and default to dry-run so operators can preview historical NULL-only updates before writing.
   */
  router.post("/command-center/productivity/backfill-loc", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const body = (req.body ?? {}) as { dryRun?: unknown };
      const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : true;
      const result = await store.backfillCommitAssociationDiffStats({ dryRun });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to backfill productivity LOC stats");
    }
  });

  /**
   * GET /api/command-center/team
   * Per-agent store-derived tokens/cost, files changed, task counts, and live identity.
   *
   * FNXC:CommandCenter 2026-06-18-16:57:
   * The Team endpoint must inherit Command Center auth and resolve getScopedStore(req) before aggregation so project-A callers cannot read project-B agent rows or task metrics. It intentionally omits GitHub issue stats; FN-6653 owns that overlay.
   */
  router.get("/command-center/team", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      const settings = await store.getGlobalSettingsStore().getSettings();
      // FNXC:PostgresCommandCenterAnalytics 2026-06-27-10:00:
      // Team analytics now runs on the AsyncDataLayer in backend mode.
      const result = await aggregateTeamAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
        now: Date.now(),
        pricingOverrides: settings.modelPricingOverrides,
      });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate team analytics");
    }
  });

  /**
   * GET /api/command-center/workflows
   * Per-workflow store-derived tokens/cost, files changed, and task counts.
   */
  router.get("/command-center/workflows", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      const settings = await store.getGlobalSettingsStore().getSettings();
      const defaultWorkflowId = (await store.getDefaultWorkflowId()) ?? "builtin:coding";
      // FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
      // Workflow analytics now runs on the AsyncDataLayer in backend mode; pass
      // the async layer when present, otherwise the sync SQLite handle, and await.
      const result = await aggregateWorkflowAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
        now: Date.now(),
        pricingOverrides: settings.modelPricingOverrides,
        defaultWorkflowId,
      });
      if (wantsCsv(req.query)) {
        sendCsv(res, "command-center-workflows.csv", workflowAnalyticsToTable(result));
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate workflow analytics");
    }
  });

  /**
   * GET /api/command-center/github
   * GitHub issues filed by Fusion and imported GitHub issues fixed by Fusion.
   */
  router.get("/command-center/github", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      // FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
      // GitHub issue analytics now runs on the AsyncDataLayer in backend mode.
      const result = await aggregateGithubIssueAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
      });
      if (wantsCsv(req.query)) {
        sendCsv(res, "command-center-github.csv", githubIssueAnalyticsToTable(result));
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate GitHub issue analytics");
    }
  });

  /**
   * GET /api/command-center/signals/connectors
   * Per-provider signal connector configuration status without secret values.
   *
   * FNXC:CommandCenter 2026-06-25-22:36:
   * The Signals empty state must be honest about setup state. Expose configured booleans through the same scoped/authenticated Command Center route family, never the raw HMAC secret, so the UI can avoid implying data merely has not arrived when no provider is configured.
   */
  router.get("/command-center/signals/connectors", async (req, res) => {
    try {
      await getScopedStore(req);
      res.json({ connectors: listSignalConnectorStatus() });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to list signal connector status");
    }
  });

  /**
   * GET /api/command-center/signals
   * External Signals metrics backed by locally recorded incidents.
   *
   * FNXC:CommandCenter 2026-06-19-00:00:
   * The Signals surface must not be a phantom endpoint. Mirror sibling Command Center routes by resolving getScopedStore(req) before reading incidents, so project-A callers only see project-A signal volume and MTTR stays the honest unavailable sentinel when no incidents are resolved. Include connector configuration separately from counts so the UI can distinguish "not configured" from "configured but quiet" without using the write-only ingestion bearer-token path.
   */
  router.get("/command-center/signals", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      // FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
      // Signal analytics now runs on the AsyncDataLayer in backend mode.
      const result = await aggregateSignalsAnalytics(store.getAsyncLayer() ?? store.getDatabase(), {
        from: range.from,
        to: range.to,
      });
      const configured = resolveConfiguredSignalProviders();
      res.json({
        ...result,
        connectors: {
          configured,
          anyConfigured: configured.length > 0,
        },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate signal analytics");
    }
  });

  /**
   * GET /api/command-center/plugin-activations
   * Project-scoped plugin/extension activation rows for Ecosystem analytics.
   */
  router.get("/command-center/plugin-activations", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const range = resolveRange(req.query);
      // FNXC:RuntimeSatelliteAsync 2026-06-24-13:15:
      // Pass the async layer when in backend mode; otherwise pass the sync DB.
      const dbOrLayer = store.getAsyncLayer() ?? store.getDatabase();
      const result = await aggregatePluginActivations(dbOrLayer, {
        from: range.from,
        to: range.to,
      });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to aggregate plugin activation analytics");
    }
  });

  /**
   * GET /api/command-center/live
   * Live Mission-Control snapshot (U6a): active sessions/runs/nodes + current
   * per-column task counts. No date range — current state only. Scoped + authed
   * like every other endpoint.
   */
  router.get("/command-center/live", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      // FNXC:PostgresCommandCenterAnalytics 2026-06-28-09:30:
      // Live snapshot now runs on the AsyncDataLayer in backend mode.
      const result = await composeLiveSnapshot(store.getAsyncLayer() ?? store.getDatabase());
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to compose live snapshot");
    }
  });
};
