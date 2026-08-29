import { spawn } from "node:child_process";
import { win32 } from "node:path";

export interface HermesLaunchSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** The selected Hermes executable, never the cmd.exe wrapper. */
  resolvedBinaryPath?: string;
}

export interface HermesLaunchDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runWhere?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
export const NEGATIVE_RESULT_TTL_MS = 30_000;
export const MAX_CACHE_ENTRIES = 32;

interface CachedResolution {
  promise: Promise<string | undefined>;
  createdAt: number;
}

const resolutionCache = new Map<string, CachedResolution>();

/*
FNXC:HermesCli 2026-08-15-15:46:
Fusion resolves but never installs, downloads, or pins the operator-installed Hermes CLI. Node refuses direct `.cmd`/`.bat` spawns without a shell, so shims are explicitly launched through cmd.exe with escaped data rather than a blanket shell option.

FNXC:HermesCli 2026-08-15-15:46:
Windows candidate paths must use path.win32 even on POSIX test hosts: host path parsing turns C:\\shims\\hermes.cmd into `.` and defeats first-directory selection. Windows lookup chooses the first PATH directory then PATHEXT precedence inside it, matching where-style discovery.

FNXC:HermesCli 2026-08-15-15:46:
Only prompt-free binary lookup is cached. Launch specs contain prompt argv and must be rebuilt per turn; misses expire so a newly installed Hermes is discovered without restart.
*/
function effectivePathExt(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT?.trim() || DEFAULT_PATHEXT;
  return raw.split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`).toLowerCase());
}

function isWindowsPath(value: string): boolean {
  return value.includes("\\") || value.includes("/") || /^[A-Za-z]:/.test(value) || /^\\\\/.test(value);
}

function cacheKey(binary: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return `${platform}|${binary.toLowerCase()}|${env.PATH ?? ""}|${env.PATHEXT ?? ""}`;
}

function evictOldestIfNeeded(): void {
  while (resolutionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = resolutionCache.keys().next().value as string | undefined;
    if (!oldest) return;
    resolutionCache.delete(oldest);
  }
}

async function defaultRunWhere(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("where", [binary], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 && stdout.trim() ? stdout : undefined));
  });
}

function chooseWhereCandidate(stdout: string, env: NodeJS.ProcessEnv): string | undefined {
  const directories: Array<{ entries: string[] }> = [];
  const byDirectory = new Map<string, { entries: string[] }>();
  for (const entry of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const directory = win32.dirname(entry).replace(/[\\/]+$/, "").toLowerCase();
    const group = byDirectory.get(directory) ?? { entries: [] };
    if (!byDirectory.has(directory)) {
      byDirectory.set(directory, group);
      directories.push(group);
    }
    group.entries.push(entry);
  }
  const firstDirectory = directories[0];
  if (!firstDirectory) return undefined;
  const pathExt = effectivePathExt(env);
  return [...firstDirectory.entries].sort((left, right) => {
    const leftIndex = pathExt.indexOf(win32.extname(left).toLowerCase());
    const rightIndex = pathExt.indexOf(win32.extname(right).toLowerCase());
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return normalizedLeft - normalizedRight;
  })[0];
}

/** Resolve only a Windows bare binary name; this prompt-free result is cacheable. */
export async function resolveHermesBinaryPath(
  binary: string,
  deps: HermesLaunchDependencies = {},
): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "win32" || isWindowsPath(binary)) return platform === "win32" && isWindowsPath(binary) ? binary : undefined;

  const lookup = async (): Promise<string | undefined> => {
    const output = await (deps.runWhere ?? defaultRunWhere)(binary, env);
    return output ? chooseWhereCandidate(output, env) : undefined;
  };
  // Injected runners are deterministic test seams and must not share process cache state.
  if (deps.runWhere) return lookup();

  const key = cacheKey(binary, platform, env);
  const cached = resolutionCache.get(key);
  if (cached) {
    const result = await cached.promise;
    // Positive resolutions remain stable, while misses are retried after the bounded install-discovery window.
    if (result !== undefined || Date.now() - cached.createdAt < NEGATIVE_RESULT_TTL_MS) return result;
    resolutionCache.delete(key);
  }

  evictOldestIfNeeded();
  const entry: CachedResolution = { promise: lookup(), createdAt: Date.now() };
  resolutionCache.set(key, entry);
  entry.promise.catch(() => {
    if (resolutionCache.get(key) === entry) resolutionCache.delete(key);
  });
  return entry.promise;
}

/** Escape cmd.exe metacharacters in a command path without adding outer quotes. */
export function escapeWindowsShellCommand(command: string): string {
  return command.replace(/([()%!^<>&|;,\s])/g, "^$1");
}

/**
 * Quote one argv item for the cmd.exe /c payload.
 * Quoting alone is insufficient because cmd.exe expands `%` and parses command
 * separators after receiving the payload, so metacharacters are caret escaped too.
 */
export function escapeWindowsShellArgument(arg: string): string {
  const quoted = arg
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\*)$/g, "$1$1");
  return `"${quoted}"`.replace(/([()%!^<>&|;,])/g, "^$1");
}

/** Build a per-call launch specification. This deliberately never caches args. */
export async function resolveHermesLaunch(
  binary: string,
  args: readonly string[],
  deps: HermesLaunchDependencies = {},
): Promise<HermesLaunchSpec> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { command: binary, args: [...args] };
  const env = deps.env ?? process.env;
  const resolved = await resolveHermesBinaryPath(binary, { ...deps, platform, env });
  const executable = resolved ?? binary;
  const extension = win32.extname(executable).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const commandLine = `"${escapeWindowsShellCommand(executable)} ${args.map(escapeWindowsShellArgument).join(" ")}"`;
    return {
      command: env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
      resolvedBinaryPath: resolved,
    };
  }
  return { command: executable, args: [...args], resolvedBinaryPath: resolved };
}

export function __resetHermesLaunchCacheForTests(): void {
  resolutionCache.clear();
}
