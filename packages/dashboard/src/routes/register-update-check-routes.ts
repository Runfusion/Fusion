import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGlobalDir } from "@fusion/core";
import { clearUpdateCheckCache, performUpdateCheck } from "../update-check.js";
import type { ApiRouteRegistrar } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLI_PACKAGE_VERSION = (() => {
  try {
    const packageJsonPath = join(__dirname, "..", "..", "..", "cli", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };

    if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // Fall through to env/default fallback.
  }

  return process.env.npm_package_version ?? "0.0.0";
})();

export const registerUpdateCheckRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, store, rethrowAsApiError } = ctx;

  router.get("/update-check", async (_req, res) => {
    try {
      const globalSettings = await store.getGlobalSettingsStore().getSettings();
      if (globalSettings.updateCheckEnabled === false) {
        res.json({
          updateAvailable: false,
          disabled: true,
          currentVersion: CLI_PACKAGE_VERSION,
          latestVersion: null,
          lastChecked: Date.now(),
        });
        return;
      }

      const result = await performUpdateCheck(resolveGlobalDir(), CLI_PACKAGE_VERSION, {
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
      const result = await performUpdateCheck(fusionDir, CLI_PACKAGE_VERSION, {
        force: true,
      });
      res.json(result);
    } catch (error) {
      rethrowAsApiError(error, "Failed to refresh update check");
    }
  });
};
