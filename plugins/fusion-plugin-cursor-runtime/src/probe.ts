import { runCursorCommand } from "./cli-spawn.js";
import type { CursorBinaryStatus } from "./types.js";

const CANDIDATES = ["cursor-agent", "cursor"] as const;
const MAX_FAILURE_DETAIL_LENGTH = 180;

function summarizeFailure(binary: string, stdout: string, stderr: string): string | undefined {
  const detail = `${stderr || stdout}`.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  const truncated = detail.length > MAX_FAILURE_DETAIL_LENGTH ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…` : detail;
  return `${binary}: ${truncated}`;
}

export async function probeCursorBinary(options?: { timeoutMs?: number; binaryPath?: string }): Promise<CursorBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 3000;
  const candidates = options?.binaryPath ? [options.binaryPath] : [...CANDIDATES];
  const failureDetails: string[] = [];

  for (const binary of candidates) {
    const version = await runCursorCommand(binary, ["--version"], timeoutMs);
    const failureDetail = summarizeFailure(binary, version.stdout, version.stderr);
    if (failureDetail) failureDetails.push(failureDetail);
    if (version.code === 0) {
      // NOTE: Cursor CLI currently lacks a stable auth-status contract we can
      // invoke without side effects. Treating successful --version as ready is
      // a best-effort heuristic; keychain/auth errors are handled by fallback
      // probes below when surfaced in stderr/stdout.
      return {
        available: true,
        authenticated: true,
        binaryName: binary,
        binaryPath: binary,
        version: version.stdout.trim() || undefined,
        probeDurationMs: Date.now() - startedAt,
      };
    }

    const combined = `${version.stdout}\n${version.stderr}`.toLowerCase();
    if (combined.includes("keychain is locked")) {
      return {
        available: true,
        authenticated: false,
        binaryName: binary,
        binaryPath: binary,
        reason: "macOS login keychain is locked",
        probeDurationMs: Date.now() - startedAt,
      };
    }

    if (combined.includes("no cursor ide installation found")) {
      return {
        available: true,
        authenticated: false,
        binaryName: binary,
        binaryPath: binary,
        reason: "Cursor IDE installation not found",
        probeDurationMs: Date.now() - startedAt,
      };
    }
  }

  const baseReason = options?.binaryPath ? `${options.binaryPath} not found on PATH` : "cursor-agent/cursor not found on PATH";
  return {
    available: false,
    authenticated: false,
    reason: failureDetails.length > 0 ? `${baseReason} (${failureDetails.join("; ")})` : baseReason,
    probeDurationMs: Date.now() - startedAt,
  };
}
