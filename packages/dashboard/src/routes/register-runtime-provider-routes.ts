import { ApiError, badRequest } from "../api-error.js";
import {
  discoverPaperclipCli,
  listHermesProviderProfiles,
  listPaperclipCompanies,
  listPaperclipCompanyAgents,
  mintPaperclipKeyViaCli,
  probeHermesProvider,
  probeOpenClawProvider,
  probePaperclipProvider,
} from "../runtime-provider-probes.js";
import type { ApiRouteRegistrar } from "./types.js";

/**
 * Registers three read-only status probes for the runtime provider plugins:
 *
 *   GET /providers/hermes/status
 *   GET /providers/openclaw/status
 *   GET /providers/paperclip/status
 *
 * These routes mirror the existing GET /providers/claude-cli/status pattern
 * in register-auth-routes.ts. They intentionally do NOT require authentication
 * because they are introspection endpoints consumed by the provider-card UI.
 */
export const registerRuntimeProviderRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, rethrowAsApiError } = ctx;

  /**
   * GET /providers/hermes/status
   *
   * Query params:
   *   binaryPath? — override the hermes binary path (default: "hermes")
   *
   * Response: { binary: HermesBinaryStatus, ready: boolean }
   *   ready === binary.available
   */
  router.get("/providers/hermes/status", async (req, res) => {
    try {
      const binaryPath =
        typeof req.query.binaryPath === "string" ? req.query.binaryPath : undefined;
      const binary = await probeHermesProvider({ binaryPath });
      res.json({ binary, ready: binary.available });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /providers/hermes/profiles
   *
   * Query params:
   *   binaryPath? — override the hermes binary path (default: "hermes")
   *
   * Response: { profiles: HermesProfileSummary[] }
   *   On any error: { profiles: [], error: "<reason>" } with HTTP 200.
   */
  router.get("/providers/hermes/profiles", async (req, res) => {
    const binaryPath =
      typeof req.query.binaryPath === "string" ? req.query.binaryPath : undefined;
    try {
      const profiles = await listHermesProviderProfiles({ binaryPath });
      res.json({ profiles });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ profiles: [], error: message });
    }
  });

  /**
   * GET /providers/openclaw/status
   *
   * Query params:
   *   binaryPath? — override the openclaw binary path (default: "openclaw")
   *
   * Response: { binary: OpenClawBinaryStatus, ready: boolean }
   *   ready === binary.available
   */
  router.get("/providers/openclaw/status", async (req, res) => {
    try {
      const binaryPath =
        typeof req.query.binaryPath === "string" ? req.query.binaryPath : undefined;
      const binary = await probeOpenClawProvider({ binaryPath });
      res.json({ binary, ready: binary.available });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /providers/paperclip/status
   *
   * Query params:
   *   apiUrl  — REQUIRED. The Paperclip server base URL (must start with http:// or https://).
   *   apiKey? — Optional API key forwarded to the probe.
   *
   * Response: { connection: PaperclipConnectionStatus, ready: boolean }
   *   ready === connection.available
   *
   * Returns 400 when apiUrl is missing or does not start with http:// or https://.
   */
  router.get("/providers/paperclip/status", async (req, res) => {
    try {
      const rawApiUrl = req.query.apiUrl;
      if (typeof rawApiUrl !== "string" || rawApiUrl.trim() === "") {
        throw badRequest("Missing required query parameter: apiUrl");
      }
      const apiUrl = rawApiUrl.trim();
      if (!apiUrl.startsWith("http://") && !apiUrl.startsWith("https://")) {
        throw badRequest("Invalid apiUrl: must start with http:// or https://");
      }

      const apiKey =
        typeof req.query.apiKey === "string" ? req.query.apiKey : undefined;

      const connection = await probePaperclipProvider({ apiUrl, apiKey });
      res.json({ connection, ready: connection.available });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /providers/paperclip/companies
   *
   * Query: apiUrl (required), apiKey?
   * Returns: { companies: PaperclipCompanySummary[] } — never throws on
   * upstream failure; an empty list signals "no companies visible".
   */
  router.get("/providers/paperclip/companies", async (req, res) => {
    try {
      const apiUrl = readApiUrl(req.query.apiUrl);
      const apiKey =
        typeof req.query.apiKey === "string" ? req.query.apiKey : undefined;
      const companies = await listPaperclipCompanies({ apiUrl, apiKey });
      res.json({ companies });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /providers/paperclip/agents
   *
   * Query: apiUrl (required), companyId (required), apiKey?
   * Returns: { agents: PaperclipAgentSummary[] } — empty list on upstream error.
   */
  router.get("/providers/paperclip/agents", async (req, res) => {
    try {
      const apiUrl = readApiUrl(req.query.apiUrl);
      const apiKey =
        typeof req.query.apiKey === "string" ? req.query.apiKey : undefined;
      const companyId =
        typeof req.query.companyId === "string"
          ? req.query.companyId.trim()
          : "";
      if (!companyId) {
        throw badRequest("Missing required query parameter: companyId");
      }
      const agents = await listPaperclipCompanyAgents({ apiUrl, apiKey, companyId });
      res.json({ agents });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /providers/paperclip/cli-discovery
   *
   * Query: cliConfigPath?
   * Returns the result of reading the local paperclipai config (apiUrl,
   * deploymentMode, etc.). Never throws — failures are reported as
   * `{ ok: false, reason }` so the card can render a clear error state.
   */
  router.get("/providers/paperclip/cli-discovery", async (req, res) => {
    try {
      const cliConfigPath =
        typeof req.query.cliConfigPath === "string"
          ? req.query.cliConfigPath
          : undefined;
      const result = await discoverPaperclipCli({ cliConfigPath });
      res.json(result);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /providers/paperclip/cli-mint-key
   *
   * Body: { agentRef (required), cliBinaryPath?, companyId?, keyName?, configPath?, dataDir? }
   *
   * Spawns `paperclipai agent local-cli <agentRef> --json --no-install-skills` to
   * mint a fresh agent API key.  Always responds HTTP 200; failures are reported as
   * `{ ok: false, reason }` so the card can render an inline error.
   *
   * Returns 400 if `agentRef` is missing or empty.
   */
  router.post("/providers/paperclip/cli-mint-key", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const agentRef =
        typeof body.agentRef === "string" ? body.agentRef.trim() : "";
      if (!agentRef) {
        throw badRequest("Missing required body field: agentRef");
      }
      const cliBinaryPath =
        typeof body.cliBinaryPath === "string" && body.cliBinaryPath.trim()
          ? body.cliBinaryPath.trim()
          : undefined;
      const companyId =
        typeof body.companyId === "string" ? body.companyId.trim() : "";
      if (!companyId) {
        throw badRequest(
          "Missing required body field: companyId (paperclipai agent local-cli requires -C/--company-id)",
        );
      }
      const keyName =
        typeof body.keyName === "string" && body.keyName.trim()
          ? body.keyName.trim()
          : undefined;
      const configPath =
        typeof body.configPath === "string" && body.configPath.trim()
          ? body.configPath.trim()
          : undefined;
      const dataDir =
        typeof body.dataDir === "string" && body.dataDir.trim()
          ? body.dataDir.trim()
          : undefined;

      const result = await mintPaperclipKeyViaCli({
        agentRef,
        cliBinaryPath,
        companyId,
        keyName,
        configPath,
        dataDir,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
};

/**
 * Validate the apiUrl query param (must be present + http(s)).
 * Throws an ApiError(400) on failure.
 */
function readApiUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw badRequest("Missing required query parameter: apiUrl");
  }
  const apiUrl = raw.trim();
  if (!apiUrl.startsWith("http://") && !apiUrl.startsWith("https://")) {
    throw badRequest("Invalid apiUrl: must start with http:// or https://");
  }
  return apiUrl;
}
