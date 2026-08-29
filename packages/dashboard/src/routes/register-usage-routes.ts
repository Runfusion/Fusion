import { ApiError } from "../api-error.js";
import { fetchAllProviderUsage } from "../usage.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerUsageRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, rethrowAsApiError } = ctx;

  /**
   * GET /api/usage
   * Fetch AI provider subscription usage (Claude, Codex, Gemini).
   * Returns: { providers: ProviderUsage[] }
   *
   * Cached for 30 seconds to avoid hitting provider API rate limits.
   * Each provider's status is independent — one failure doesn't break all.
   */
  router.get("/usage", async (_req, res) => {
    try {
      const providers = await fetchAllProviderUsage(options?.authStorage);
      res.json({ providers });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to fetch usage data");
    }
  });
};
