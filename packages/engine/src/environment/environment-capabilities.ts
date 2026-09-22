import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type EnvironmentCapability = {
  name: string;
  available: boolean;
  /** A confirmed project wrapper that exposed this command beyond the host PATH. */
  via?: string;
};

export type EnvironmentCapabilityProbe = {
  capabilities: EnvironmentCapability[];
  degraded: boolean;
};

export const BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS = Object.freeze([
  "node", "pnpm", "npm", "yarn", "bun", "deno", "python3", "python", "go", "cargo", "rustc",
  "java", "mvn", "gradle", "ruby", "php", "dotnet", "make", "docker", "git",
  "nix", "direnv", "devbox", "nvm", "fnm", "asdf", "mise",
] as const);

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_TTL_MS = 60_000;
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const SAFE_COMMAND_NAME = /^[A-Za-z0-9._+/-]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const probeCache = new Map<string, { createdAt: number; promise: Promise<EnvironmentCapabilityProbe> }>();

type WrapperContext = { prefix: string[]; display: string; innerCandidates: string[] };

function unquoteToken(token: string): string {
  if (token.length >= 2 && ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'")))) return token.slice(1, -1);
  return token;
}

/** Extract leading executables from shell segments without executing shell syntax. */
export function extractCommandBinaries(command?: string): string[] {
  if (!command?.trim()) return [];
  const binaries: string[] = [];
  for (const segment of command.split(/\s*(?:&&|\|\||[|;])\s*/)) {
    const tokens = segment.trim().split(/\s+/).map(unquoteToken).filter(Boolean);
    let index = 0;
    if (tokens[index] === "env") index += 1;
    while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) index += 1;
    const binary = tokens[index];
    if (binary && SAFE_COMMAND_NAME.test(binary)) binaries.push(binary);
  }
  return [...new Set(binaries)];
}

function commandTokens(command: string): string[] | null {
  if (/[;&|`$<>()[\]{}\\]/.test(command)) return null;
  const tokens = command.trim().split(/\s+/).map(unquoteToken).filter(Boolean);
  let index = tokens[0] === "env" ? 1 : 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) index += 1;
  const result = tokens.slice(index);
  return result.length > 0 && result.every((token) => SAFE_COMMAND_NAME.test(token)) ? result : null;
}

/**
 * Recognize only fixed wrapper grammars. This deliberately does not interpret repository prose or arbitrary shell.
 */
function parseRecognizedWrapper(command?: string): WrapperContext | null {
  if (!command) return null;
  const tokens = commandTokens(command);
  if (!tokens) return null;
  const wrapper = tokens[0];
  let prefix: string[] | null = null;
  let inner: string | undefined;
  if (wrapper === "nix" && tokens[1] === "develop" && tokens[2] === "--command") {
    prefix = ["nix", "develop", "--command"]; inner = tokens[3];
  } else if (wrapper === "devbox" && tokens[1] === "run") {
    prefix = ["devbox", "run"]; inner = tokens[2];
  } else if ((wrapper === "nvm" || wrapper === "fnm") && tokens[1] === "exec") {
    prefix = tokens.slice(0, 3); inner = tokens[3];
  } else if ((wrapper === "asdf" || wrapper === "mise") && tokens[1] === "exec") {
    prefix = tokens.slice(0, 2); inner = tokens[2];
  } else if (wrapper === "direnv" && tokens[1] === "exec" && tokens[2]) {
    prefix = tokens.slice(0, 3); inner = tokens[3];
  }
  if (!prefix || !inner || !SAFE_COMMAND_NAME.test(inner)) return null;
  return { prefix, display: prefix.join(" "), innerCandidates: [inner] };
}

function collectCandidates(extraCommands: readonly string[], wrappers: readonly WrapperContext[]): string[] {
  return [...new Set([
    ...BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS,
    ...extraCommands.map((name) => name.trim()).filter((name) => SAFE_COMMAND_NAME.test(name)),
    ...wrappers.flatMap((wrapper) => wrapper.innerCandidates),
  ])].sort((a, b) => a.localeCompare(b));
}

function quoteShellToken(token: string): string { return `'${token.replaceAll("'", "'\\''")}'`; }
function buildProbeCommand(candidates: readonly string[]): string {
  return `for name in ${candidates.map(quoteShellToken).join(" ")}; do if command -v "$name" >/dev/null 2>&1; then printf '%s=1\\n' "$name"; else printf '%s=0\\n' "$name"; fi; done`;
}
function buildWrapperProbeCommand(wrapper: WrapperContext, candidates: readonly string[]): string {
  return [...wrapper.prefix.map(quoteShellToken), quoteShellToken("/bin/bash"), quoteShellToken("-c"), quoteShellToken(buildProbeCommand(candidates))].join(" ");
}

function parseProbeOutput(stdout: string, candidates: readonly string[]): EnvironmentCapabilityProbe {
  const parsed = new Map<string, boolean>();
  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const match = /^(.+)=(0|1)$/.exec(line);
    if (!match || !candidates.includes(match[1]!) || parsed.has(match[1]!)) return { capabilities: [], degraded: true };
    parsed.set(match[1]!, match[2] === "1");
  }
  if (parsed.size !== candidates.length) return { capabilities: [], degraded: true };
  return { capabilities: candidates.map((name) => ({ name, available: parsed.get(name)! })), degraded: false };
}

async function runProbe(command: string, candidates: readonly string[], timeoutMs: number): Promise<EnvironmentCapabilityProbe> {
  try {
    const { stdout } = await execAsync(command, { timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER_BYTES, encoding: "utf-8", shell: "/bin/bash" });
    return parseProbeOutput(stdout ?? "", candidates);
  } catch { return { capabilities: [], degraded: true }; }
}

async function rootNixWrapper(rootDir?: string): Promise<{ wrapper: WrapperContext | null; fingerprint: string }> {
  if (!rootDir) return { wrapper: null, fingerprint: "no-root" };
  try {
    // FNXC:EnvironmentCapabilities 2026-09-22-03:05: A root flake is bounded evidence for the fixed Nix dev-shell prefix; its contents are never parsed or executed.
    const content = await readFile(join(rootDir, "flake.nix"), "utf8");
    return { wrapper: { prefix: ["nix", "develop", "--command"], display: "nix develop --command", innerCandidates: [] }, fingerprint: `flake:${content.length}:${content.slice(0, 256)}` };
  } catch { return { wrapper: null, fingerprint: "no-flake" }; }
}

async function probeUncached(candidates: readonly string[], wrappers: readonly WrapperContext[], timeoutMs: number): Promise<EnvironmentCapabilityProbe> {
  const host = await runProbe(buildProbeCommand(candidates), candidates, timeoutMs);
  if (host.degraded) return host;
  const merged = new Map(host.capabilities.map((capability) => [capability.name, capability]));
  for (const wrapper of wrappers) {
    if (!merged.get(wrapper.prefix[0])?.available) continue;
    const wrapped = await runProbe(buildWrapperProbeCommand(wrapper, candidates), candidates, timeoutMs);
    if (wrapped.degraded) continue;
    for (const capability of wrapped.capabilities) {
      if (capability.available && !merged.get(capability.name)?.available) merged.set(capability.name, { ...capability, via: wrapper.display });
    }
  }
  return { capabilities: candidates.map((candidate) => merged.get(candidate)!), degraded: false };
}

/*
FNXC:EnvironmentCapabilities 2026-09-22-03:05:
FN-9357 separates host availability from a recognized project wrapper. A failed wrapper probe never manufactures availability, while a root flake may select only the fixed Nix prefix.
*/
export async function probeEnvironmentCapabilities(options: {
  extraCommands?: readonly string[];
  testCommand?: string;
  buildCommand?: string;
  rootDir?: string;
  projectId?: string;
  timeoutMs?: number;
  now?: () => number;
} = {}): Promise<EnvironmentCapabilityProbe> {
  const marker = await rootNixWrapper(options.rootDir);
  const configured = [parseRecognizedWrapper(options.testCommand), parseRecognizedWrapper(options.buildCommand)].filter((value): value is WrapperContext => value !== null);
  const wrappers = [...new Map([...configured, ...(marker.wrapper ? [marker.wrapper] : [])].map((wrapper) => [wrapper.display, wrapper])).values()];
  const candidates = collectCandidates(options.extraCommands ?? [], wrappers);
  const normalizedCommands = [options.testCommand?.trim() ?? "", options.buildCommand?.trim() ?? ""].join("\u0000");
  const cacheKey = [options.projectId ?? options.rootDir ?? "host", normalizedCommands, marker.fingerprint, candidates.join("\u0000")].join("\u0001");
  const now = options.now?.() ?? Date.now();
  const cached = probeCache.get(cacheKey);
  if (cached && now - cached.createdAt < PROBE_CACHE_TTL_MS) return cached.promise;
  const promise = probeUncached(candidates, wrappers, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  probeCache.set(cacheKey, { createdAt: now, promise });
  return promise;
}

export function formatEnvironmentCapabilitiesSection(probe: EnvironmentCapabilityProbe): string {
  if (probe.degraded || probe.capabilities.length === 0) return "";
  const available = probe.capabilities.filter((capability) => capability.available && !capability.via).map(({ name }) => name);
  const wrapperAvailable = probe.capabilities.filter((capability) => capability.available && capability.via).map(({ name, via }) => `${name} via ${via}`);
  const unavailable = probe.capabilities.filter((capability) => !capability.available).map(({ name }) => name);
  return [
    "## Environment Capabilities", "",
    `Host-available commands: ${available.length > 0 ? available.join(", ") : "none"}`,
    `Available via confirmed project wrapper: ${wrapperAvailable.length > 0 ? wrapperAvailable.join(", ") : "none"}`,
    `Confirmed-unavailable commands: ${unavailable.length > 0 ? unavailable.join(", ") : "none"}`,
    "", "- Only the commands listed here were probed. Any unlisted command is UNKNOWN, not absent.",
    "- A documented or configured command using a confirmed wrapper remains runnable and binding even if its inner executable is absent from the host PATH.",
    "- Only a confirmed-unavailable runtime without an applicable confirmed wrapper needs a runnable substitute; record an ideal impossible check under `## Environment Constraints` as explicitly non-blocking.",
  ].join("\n");
}

export function resetEnvironmentCapabilitiesCache(): void { probeCache.clear(); }
