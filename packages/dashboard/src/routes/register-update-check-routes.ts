import { resolveGlobalDir } from "@fusion/core";
import { clearUpdateCheckCache, performUpdateCheck } from "../update-check.js";
import { getCliPackageVersion } from "../cli-package-version.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerUpdateCheckRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;
  const cliPackageVersion = getCliPackageVersion(import.meta.url);

  router.get("/update-check", async (_req, res) => {
    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      if (globalSettings.updateCheckEnabled === false) {
        res.json({
          updateAvailable: false,
          disabled: true,
          currentVersion: cliPackageVersion,
          latestVersion: null,
          lastChecked: Date.now(),
        });
        return;
      }

      const result = await performUpdateCheck(resolveGlobalDir(), cliPackageVersion, {
        frequency: globalSettings.updateCheckFrequency,
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to perform update check");
    }
  });

  router.post("/update-check/refresh", async (_req, res) => {
    try {
      const fusionDir = resolveGlobalDir();
      await clearUpdateCheckCache(fusionDir);
      // Explicit `force: true` so a "manual" frequency setting doesn't short
      // out the network fetch on the user's deliberate "Check now" click.
      const result = await performUpdateCheck(fusionDir, cliPackageVersion, {
        force: true,
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to refresh update check");
    }
  });
};
