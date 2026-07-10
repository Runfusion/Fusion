import { runCursorCommand } from "./cli-spawn.js";
import type { CursorBinaryStatus } from "./types.js";

const CANDIDATES = ["cursor-agent", "cursor"] as const;
const MAX_FAILURE_DETAIL_LENGTH = 180;

function buildCandidates(binaryPath?: string): { candidates: string[]; configuredBinaryPath?: string } {
  /*
  FNXC:CursorCli 2026-07-02-00:00:
  Manual operator paths must be tried before PATH candidates without deleting the fallback order. Deduping keeps `cursor-agent`/`cursor` overrides from probing the same shim twice while still preserving auto-detection.
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

async function probeCursorAuthStatus(binary: string, timeoutMs: number): Promise<{ authenticated: boolean; reason?: string }> {
  const status = await runCursorCommand(binary, ["status", "--format", "json"], timeoutMs);
  const output = (status.stdout || "").trim();

  if (status.code !== 0 || !output) {
    return { authenticated: false, reason: "cursor-agent status --format json did not return output" };
  }

  try {
    const parsed = JSON.parse(output) as { isAuthenticated?: unknown };
    if (typeof parsed?.isAuthenticated === "boolean") {
      return {
        authenticated: parsed.isAuthenticated,
        reason: parsed.isAuthenticated ? undefined : "cursor-agent reports not authenticated",
      };
    }
    return { authenticated: false, reason: "cursor-agent status --format json missing isAuthenticated field" };
  } catch {
    return { authenticated: false, reason: "cursor-agent status --format json returned malformed JSON" };
  }
}

export async function probeCursorBinary(options?: { timeoutMs?: number; binaryPath?: string }): Promise<CursorBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 3000;
  const { candidates, configuredBinaryPath } = buildCandidates(options?.binaryPath);
  const failureDetails: string[] = [];

  for (const binary of candidates) {
    const version = await runCursorCommand(binary, ["--version"], timeoutMs);
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
      /*
      FNXC:CursorCli 2026-07-08-00:00:
      `cursor-agent status --format json` (alias `whoami`) is the real auth
      contract, returning `{ isAuthenticated, status, hasAccessToken, userInfo }`.
      We probe it with the SAME candidate binary that just succeeded --version
      (never re-probing a different candidate), and fail closed to
      `authenticated: false` with an actionable reason on any non-zero exit or
      malformed/non-JSON output rather than throwing.
      */
      const auth = await probeCursorAuthStatus(binary, timeoutMs);
      return {
        available: true,
        authenticated: auth.authenticated,
        ...common,
        version: version.stdout.trim() || undefined,
        reason: auth.authenticated ? undefined : auth.reason,
      };
    }

    const combined = `${version.stdout}\n${version.stderr}`.toLowerCase();
    if (combined.includes("keychain is locked")) {
      return {
        available: true,
        authenticated: false,
        ...common,
        reason: "macOS login keychain is locked",
      };
    }

    if (combined.includes("no cursor ide installation found")) {
      return {
        available: true,
        authenticated: false,
        ...common,
        reason: "Cursor IDE installation not found",
      };
    }
  }

  const baseReason = configuredBinaryPath
    ? `Configured Cursor CLI binary '${configuredBinaryPath}' failed; PATH fallback cursor-agent/cursor also failed`
    : "cursor-agent/cursor not found on PATH";
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
