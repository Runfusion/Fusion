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
FNXC:GrokCli 2026-07-09-00:00:
FN-7716: the `grok` CLI resolves its OWN credentials from more sources than
Fusion can inspect (project `.env`, `GROK_BASE_URL`, `grok -k`, sandbox
secrets), on top of the two locations Fusion checks below (`GROK_API_KEY` env
var, `~/.grok/user-settings.json` `{ apiKey }`). Requiring Fusion to see a key
before treating the provider as "authenticated" produced false negatives for
operators whose CLI was fully authenticated via a method Fusion doesn't
check. Key presence is therefore surfaced ONLY as a non-blocking informational
signal (`apiKeyDetected`) consumed by `probeGrokBinary` below — it never gates
readiness/`authenticated`, which now derives solely from binary availability,
mirroring the Cursor CLI provider (`authenticated: cursorEnabled &&
cursorBinary.available`). Never throw: a missing/corrupt
`~/.grok/user-settings.json` must degrade gracefully, not crash the probe. Do
NOT invent a status subcommand for Grok (AGENTS.md / PROMPT.md "Do NOT").
*/
async function probeGrokApiKeyPresence(): Promise<{ detected: boolean; reason?: string }> {
  const envKey = process.env.GROK_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return { detected: true };
  }

  const settingsPath = join(homedir(), ".grok", "user-settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch {
    return { detected: false, reason: "No Grok API key detected by Fusion (GROK_API_KEY unset, ~/.grok/user-settings.json not found); the CLI will use its own credentials." };
  }

  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length > 0) {
      return { detected: true };
    }
    return { detected: false, reason: "No Grok API key detected by Fusion (~/.grok/user-settings.json has no non-empty apiKey field); the CLI will use its own credentials." };
  } catch {
    return { detected: false, reason: "No Grok API key detected by Fusion (~/.grok/user-settings.json is malformed JSON); the CLI will use its own credentials." };
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
      // FNXC:GrokCli 2026-07-09-00:00: readiness = binary available; the CLI owns auth (FN-7716).
      const keyPresence = await probeGrokApiKeyPresence();
      return {
        available: true,
        authenticated: true,
        apiKeyDetected: keyPresence.detected,
        ...common,
        version: version.stdout.trim() || undefined,
        reason: keyPresence.detected ? undefined : keyPresence.reason,
      };
    }
  }

  const baseReason = configuredBinaryPath
    ? `Configured Grok CLI binary '${configuredBinaryPath}' failed; PATH fallback grok also failed`
    : "grok not found on PATH";
  return {
    available: false,
    authenticated: false,
    apiKeyDetected: false,
    configuredBinaryPath,
    usingConfiguredBinaryPath: false,
    diagnostics: failureDetails.length > 0 ? failureDetails : undefined,
    reason: failureDetails.length > 0 ? `${baseReason} (${failureDetails.join("; ")})` : baseReason,
    probeDurationMs: Date.now() - startedAt,
  };
}
