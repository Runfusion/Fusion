import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runGrokCommand } from "./cli-spawn.js";
import type { GrokBinaryStatus } from "./types.js";

const CANDIDATES = ["grok"] as const;
const MAX_FAILURE_DETAIL_LENGTH = 180;

function buildCandidates(binaryPath?: string): { candidates: string[]; configuredBinaryPath?: string } {
  /*
  FNXC:GrokCli 2026-07-08-00:00:
  Manual operator paths must be tried before PATH candidates without deleting the fallback order, mirroring the Cursor plugin's probe. Deduping keeps a `grok` override from probing the same shim twice while still preserving auto-detection.
  */
  const configuredBinaryPath = binaryPath?.trim() || undefined;
  const ordered = configuredBinaryPath ? [configuredBinaryPath, ...CANDIDATES] : [...CANDIDATES];
  return { candidates: Array.from(new Set(ordered)), configuredBinaryPath };
}

function summarizeFailure(binary: string, stdout: string, stderr: string): string | undefined {
  const detail = `${stderr || stdout}`.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  const truncated = detail.length > MAX_FAILURE_DETAIL_LENGTH ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…` : detail;
  return `${binary}: ${truncated}`;
}

/*
FNXC:GrokCli 2026-07-08-00:00:
Grok is API-key auth, NOT an OAuth/session CLI like Cursor — there is no
`grok status --format json` (or `whoami`) subcommand to probe. Auth is a Grok
API key supplied via the `GROK_API_KEY` env var OR `~/.grok/user-settings.json`
`{ "apiKey": ... }` (per the upstream README, verified 2026-07-08). We derive
`authenticated` from key PRESENCE only — env var first, then the settings
file — and fail closed to `authenticated: false` with an actionable reason on
a missing key or an unreadable/malformed settings file. Never throw: a
missing/corrupt `~/.grok/user-settings.json` must degrade gracefully, not
crash the probe. Do NOT invent a status subcommand for Grok (AGENTS.md /
PROMPT.md "Do NOT").
*/
async function probeGrokApiKeyPresence(): Promise<{ authenticated: boolean; reason?: string }> {
  const envKey = process.env.GROK_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return { authenticated: true };
  }

  const settingsPath = join(homedir(), ".grok", "user-settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch {
    return { authenticated: false, reason: "GROK_API_KEY is not set and ~/.grok/user-settings.json was not found" };
  }

  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0) {
      return { authenticated: true };
    }
    return { authenticated: false, reason: "~/.grok/user-settings.json has no non-empty apiKey field" };
  } catch {
    return { authenticated: false, reason: "~/.grok/user-settings.json is malformed JSON" };
  }
}

export async function probeGrokBinary(options?: { timeoutMs?: number; binaryPath?: string }): Promise<GrokBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 3000;
  const { candidates, configuredBinaryPath } = buildCandidates(options?.binaryPath);
  const failureDetails: string[] = [];

  for (const binary of candidates) {
    const version = await runGrokCommand(binary, ["--version"], timeoutMs);
    const failureDetail = summarizeFailure(binary, version.stdout, version.stderr);
    if (failureDetail) failureDetails.push(failureDetail);
    const common = {
      binaryName: binary,
      binaryPath: binary,
      configuredBinaryPath,
      usingConfiguredBinaryPath: configuredBinaryPath === binary,
      diagnostics: failureDetails.length > 0 ? [...failureDetails] : undefined,
      probeDurationMs: Date.now() - startedAt,
    };
    if (version.code === 0) {
      const auth = await probeGrokApiKeyPresence();
      return {
        available: true,
        authenticated: auth.authenticated,
        ...common,
        version: version.stdout.trim() || undefined,
        reason: auth.authenticated ? undefined : auth.reason,
      };
    }
  }

  const baseReason = configuredBinaryPath
    ? `Configured Grok CLI binary '${configuredBinaryPath}' failed; PATH fallback grok also failed`
    : "grok not found on PATH";
  return {
    available: false,
    authenticated: false,
    configuredBinaryPath,
    usingConfiguredBinaryPath: false,
    diagnostics: failureDetails.length > 0 ? failureDetails : undefined,
    reason: failureDetails.length > 0 ? `${baseReason} (${failureDetails.join("; ")})` : baseReason,
    probeDurationMs: Date.now() - startedAt,
  };
}
