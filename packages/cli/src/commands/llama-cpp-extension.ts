import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

export type LlamaCppExtensionResolution =
  | { status: "ok"; path: string; packageVersion: string }
  | { status: "not-installed" }
  | { status: "missing-entry"; reason: string }
  | { status: "error"; reason: string };

export function resolveLlamaCppExtensionFromModuleUrl(
  moduleUrl: string,
): LlamaCppExtensionResolution {
  let pkgJsonPath: string | undefined;

  const here = dirname(fileURLToPath(moduleUrl));
  for (const rel of ["pi-llama-cpp", "../pi-llama-cpp", "../../pi-llama-cpp"]) {
    const candidate = resolve(here, rel, "package.json");
    if (existsSync(candidate)) {
      pkgJsonPath = candidate;
      break;
    }
  }

  if (!pkgJsonPath) {
    try {
      pkgJsonPath = require_.resolve("@fusion/pi-llama-cpp/package.json");
    } catch {
      return { status: "not-installed" };
    }
  }

  let pkgJson: { pi?: { extensions?: unknown }; version?: string };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof pkgJson;
  } catch (err) {
    return {
      status: "error",
      reason: `Failed to read @fusion/pi-llama-cpp package.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const extensions = pkgJson.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/pi-llama-cpp package.json has no pi.extensions array",
    };
  }

  const rawEntry = extensions[0];
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    return {
      status: "missing-entry",
      reason: "@fusion/pi-llama-cpp pi.extensions[0] is not a valid path string",
    };
  }

  const entryPath = resolve(dirname(pkgJsonPath), rawEntry);
  if (!existsSync(entryPath)) {
    return {
      status: "missing-entry",
      reason: `@fusion/pi-llama-cpp extension file not found at ${entryPath}`,
    };
  }

  return { status: "ok", path: entryPath, packageVersion: pkgJson.version ?? "unknown" };
}

export function resolveLlamaCppExtension(): LlamaCppExtensionResolution {
  return resolveLlamaCppExtensionFromModuleUrl(import.meta.url);
}

export function resolveLlamaCppExtensionPaths(globalSettings: {
  useLlamaCpp?: unknown;
}): { paths: string[]; warning?: string; resolution: LlamaCppExtensionResolution | null } {
  const enabled = globalSettings?.useLlamaCpp === true;
  if (!enabled) return { paths: [], resolution: null };

  const resolution = resolveLlamaCppExtension();
  switch (resolution.status) {
    case "ok":
      return { paths: [resolution.path], resolution };
    case "not-installed":
      return {
        paths: [],
        resolution,
        warning:
          "useLlamaCpp is on but @fusion/pi-llama-cpp is not installed in node_modules. Run `pnpm install`.",
      };
    case "missing-entry":
    case "error":
      return { paths: [], resolution, warning: resolution.reason };
  }
}

let cachedResolution: LlamaCppExtensionResolution | null = null;

export function setCachedLlamaCppResolution(
  resolution: LlamaCppExtensionResolution | null,
): void {
  cachedResolution = resolution;
}

export function getCachedLlamaCppResolution(): LlamaCppExtensionResolution | null {
  return cachedResolution;
}

export const _testInternals = {
  moduleUrl: (): string => fileURLToPath(import.meta.url),
};
