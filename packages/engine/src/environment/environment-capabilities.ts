import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type EnvironmentCapability = {
  name: string;
  available: boolean;
};

export type EnvironmentCapabilityProbe = {
  capabilities: EnvironmentCapability[];
  degraded: boolean;
};

export const BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS = Object.freeze([
  "node",
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "deno",
  "python3",
  "python",
  "go",
  "cargo",
  "rustc",
  "java",
  "mvn",
  "gradle",
  "ruby",
  "php",
  "dotnet",
  "make",
  "docker",
  "git",
] as const);

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const SAFE_COMMAND_NAME = /^[A-Za-z0-9._+/-]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const probeCache = new Map<string, Promise<EnvironmentCapabilityProbe>>();

function unquoteToken(token: string): string {
  if (
    token.length >= 2
    && ((token.startsWith("\"") && token.endsWith("\""))
      || (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Extract the leading executable from each shell command segment without executing it.
 */
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

function collectCandidates(extraCommands: readonly string[]): string[] {
  return [...new Set([
    ...BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS,
    ...extraCommands.map((name) => name.trim()).filter((name) => SAFE_COMMAND_NAME.test(name)),
  ])].sort((a, b) => a.localeCompare(b));
}

function quoteShellToken(token: string): string {
  return `'${token.replaceAll("'", "'\\''")}'`;
}

function buildProbeCommand(candidates: readonly string[]): string {
  const args = candidates.map(quoteShellToken).join(" ");
  return `for name in ${args}; do if command -v "$name" >/dev/null 2>&1; then printf '%s=1\\n' "$name"; else printf '%s=0\\n' "$name"; fi; done`;
}

function parseProbeOutput(stdout: string, candidates: readonly string[]): EnvironmentCapabilityProbe {
  const parsed = new Map<string, boolean>();
  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const match = /^(.+)=(0|1)$/.exec(line);
    if (!match || !candidates.includes(match[1]!) || parsed.has(match[1]!)) {
      return { capabilities: [], degraded: true };
    }
    parsed.set(match[1]!, match[2] === "1");
  }

  if (parsed.size !== candidates.length) return { capabilities: [], degraded: true };
  return {
    capabilities: candidates.map((name) => ({ name, available: parsed.get(name)! })),
    degraded: false,
  };
}

async function probeUncached(
  candidates: readonly string[],
  timeoutMs: number,
): Promise<EnvironmentCapabilityProbe> {
  try {
    const { stdout } = await execAsync(buildProbeCommand(candidates), {
      timeout: timeoutMs,
      maxBuffer: PROBE_MAX_BUFFER_BYTES,
      encoding: "utf-8",
      shell: "/bin/bash",
    });
    return parseProbeOutput(stdout ?? "", candidates);
  } catch {
    return { capabilities: [], degraded: true };
  }
}

/*
FNXC:PlanValidation 2026-08-28-22:15:
FN-243 makes runtime availability a deterministic planning fact. The cached host probe is one bounded,
fail-open shell call; probe failure injects no claim and can never prevent planning or Plan Review.
*/
export function probeEnvironmentCapabilities(options: {
  extraCommands?: readonly string[];
  timeoutMs?: number;
} = {}): Promise<EnvironmentCapabilityProbe> {
  const candidates = collectCandidates(options.extraCommands ?? []);
  const cacheKey = candidates.join("\u0000");
  let promise = probeCache.get(cacheKey);
  if (!promise) {
    promise = probeUncached(candidates, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    probeCache.set(cacheKey, promise);
  }
  return promise;
}

export function formatEnvironmentCapabilitiesSection(probe: EnvironmentCapabilityProbe): string {
  if (probe.degraded || probe.capabilities.length === 0) return "";

  const available = probe.capabilities.filter((capability) => capability.available).map(({ name }) => name);
  const unavailable = probe.capabilities.filter((capability) => !capability.available).map(({ name }) => name);
  return [
    "## Environment Capabilities",
    "",
    `Available commands: ${available.length > 0 ? available.join(", ") : "none"}`,
    `Unavailable commands: ${unavailable.length > 0 ? unavailable.join(", ") : "none"}`,
    "",
    "- Do not make an acceptance criterion or required verification depend on an unavailable runtime.",
    "- When the ideal check needs an absent runtime, keep the objective, specify a runnable substitute, and record the ideal check under an `## Environment Constraints` section of PROMPT.md as explicitly non-blocking.",
    "- This inventory describes the execution host; a repository script whose interpreter is unavailable cannot run here.",
  ].join("\n");
}

export function resetEnvironmentCapabilitiesCache(): void {
  probeCache.clear();
}
