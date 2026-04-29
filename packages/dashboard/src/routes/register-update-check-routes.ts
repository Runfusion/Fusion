import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGlobalDir } from "@fusion/core";
import { clearUpdateCheckCache, performUpdateCheck } from "../update-check.js";
import type { ApiRouteRegistrar } from "./types.js";

// Walk up from this module to find the @runfusion/fusion package.json. Works
// across layouts: monorepo source (packages/dashboard/src/...), installed
// dependency (node_modules/@runfusion/fusion/dist/...), and the bundled CLI
// binary where dashboard code is inlined into bin.js next to the cli's
// package.json. Falls back to "0.0.0" when nothing is found.
const CLI_PACKAGE_VERSION = (() => {
  try {
    let cur = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const pkgPath = resolve(cur, "package.json");
      if (existsSync(pkgPath)) {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
        if (parsed.name === "@runfusion/fusion" && typeof parsed.version === "string" && parsed.version.length > 0) {
          return parsed.version;
        }
      }
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
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
