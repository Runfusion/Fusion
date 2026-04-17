import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const FUSION_DISABLED_EXTENSIONS_KEY = "fusionDisabledExtensions";

export type PiExtensionSource = "fusion-global" | "pi-global" | "fusion-project" | "pi-project" | "package";

export interface PiExtensionEntry {
  id: string;
  name: string;
  path: string;
  source: PiExtensionSource;
  enabled: boolean;
}

export interface PiExtensionSettings {
  extensions: PiExtensionEntry[];
  disabledIds: string[];
  settingsPath: string;
}

function getHomeDir(home?: string): string {
  return home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function getFusionAgentDir(home?: string): string {
  return join(getHomeDir(home), ".fusion", "agent");
}

export function getLegacyPiAgentDir(home?: string): string {
  return join(getHomeDir(home), ".pi", "agent");
}

export function getFusionAgentSettingsPath(home?: string): string {
  return join(getFusionAgentDir(home), "settings.json");
}

export function resolvePiExtensionProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".fusion"))) {
      return current;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return resolve(cwd);
    }
    current = parent;
  }
}

function sourceForDir(dir: string, cwd: string, home?: string): PiExtensionSource {
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  const resolved = resolve(dir);
  if (resolved === resolve(projectRoot, ".fusion", "extensions")) return "fusion-project";
  if (resolved === resolve(projectRoot, ".pi", "extensions")) return "pi-project";
  if (resolved === resolve(getFusionAgentDir(home), "extensions")) return "fusion-global";
  return "pi-global";
}

function extensionName(extensionPath: string): string {
  const base = basename(extensionPath).replace(/\.(ts|js)$/i, "");
  if (base === "index") {
    return basename(resolve(extensionPath, ".."));
  }
  return base;
}

function readPiManifest(packageJsonPath: string): { extensions?: string[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: { extensions?: unknown } };
    if (parsed.pi && Array.isArray(parsed.pi.extensions)) {
      return { extensions: parsed.pi.extensions.filter((entry): entry is string => typeof entry === "string") };
    }
  } catch {
    // Ignore invalid extension manifests.
  }
  return null;
}

function resolveExtensionEntries(dir: string): string[] | null {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    const manifest = readPiManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries = manifest.extensions
        .map((entry) => resolve(dir, entry))
        .filter((entry) => existsSync(entry));
      if (entries.length > 0) return entries;
    }
  }

  const indexTs = join(dir, "index.ts");
  if (existsSync(indexTs)) return [indexTs];
  const indexJs = join(dir, "index.js");
  if (existsSync(indexJs)) return [indexJs];
  return null;
}

function discoverExtensionsInDir(dir: string, cwd: string, home?: string): PiExtensionEntry[] {
  if (!existsSync(dir)) return [];

  const discovered: PiExtensionEntry[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(dir, entry.name);

      if ((entry.isFile() || entry.isSymbolicLink()) && /\.(ts|js)$/i.test(entry.name)) {
        const resolved = resolve(entryPath);
        discovered.push({
          id: resolved,
          name: extensionName(resolved),
          path: resolved,
          source: sourceForDir(dir, cwd, home),
          enabled: true,
        });
        continue;
      }

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = statSync(entryPath).isDirectory();
          } catch {
            isDirectory = false;
          }
        }
        if (!isDirectory) continue;

        const entries = resolveExtensionEntries(entryPath);
        for (const extensionPath of entries ?? []) {
          const resolved = resolve(extensionPath);
          discovered.push({
            id: resolved,
            name: extensionName(resolved),
            path: resolved,
            source: sourceForDir(dir, cwd, home),
            enabled: true,
          });
        }
      }
    }
  } catch {
    return [];
  }

  return discovered;
}

export function getPiExtensionDiscoveryDirs(cwd: string, home?: string): string[] {
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  return [
    join(projectRoot, ".fusion", "extensions"),
    join(projectRoot, ".pi", "extensions"),
    join(getFusionAgentDir(home), "extensions"),
    join(getLegacyPiAgentDir(home), "extensions"),
  ];
}

function readFusionDisabledExtensions(settingsPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const disabled = parsed[FUSION_DISABLED_EXTENSIONS_KEY];
    return Array.isArray(disabled)
      ? disabled.filter((entry): entry is string => typeof entry === "string").map((entry) => resolve(entry))
      : [];
  } catch {
    return [];
  }
}

export function discoverPiExtensions(cwd: string, home?: string): PiExtensionSettings {
  const settingsPath = getFusionAgentSettingsPath(home);
  const disabledIds = readFusionDisabledExtensions(settingsPath);
  const disabled = new Set(disabledIds);
  const byPath = new Map<string, PiExtensionEntry>();

  for (const dir of getPiExtensionDiscoveryDirs(cwd, home)) {
    for (const entry of discoverExtensionsInDir(dir, cwd, home)) {
      byPath.set(entry.id, { ...entry, enabled: !disabled.has(entry.id) });
    }
  }

  return {
    extensions: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    disabledIds,
    settingsPath,
  };
}

export function getEnabledPiExtensionPaths(cwd: string, home?: string): string[] {
  return discoverPiExtensions(cwd, home)
    .extensions
    .filter((entry) => entry.enabled)
    .map((entry) => entry.path);
}

export function updatePiExtensionDisabledIds(cwd: string, disabledIds: string[], home?: string, extraKnownIds: string[] = []): PiExtensionSettings {
  const settingsPath = getFusionAgentSettingsPath(home);
  const existing = (() => {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const known = new Set([
    ...discoverPiExtensions(cwd, home).extensions.map((entry) => entry.id),
    ...extraKnownIds.map((entry) => resolve(entry)),
  ]);
  const normalizedDisabledIds = Array.from(new Set(
    disabledIds.map((entry) => resolve(entry)).filter((entry) => known.has(entry)),
  )).sort();

  mkdirSync(resolve(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({
    ...existing,
    [FUSION_DISABLED_EXTENSIONS_KEY]: normalizedDisabledIds,
  }, null, 2)}\n`);

  return discoverPiExtensions(cwd, home);
}

export function formatPiExtensionSource(source: PiExtensionSource, extensionPath: string, cwd: string, home?: string): string {
  const homeDir = getHomeDir(home);
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  const relativePath = extensionPath.startsWith(homeDir)
    ? `~${extensionPath.slice(homeDir.length)}`
    : extensionPath.startsWith(projectRoot)
      ? relative(projectRoot, extensionPath).split(sep).join("/")
      : extensionPath;
  return `${source}: ${relativePath}`;
}
