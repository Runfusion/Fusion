import { runOmpCommand } from "./cli-spawn.js";
import type { OmpBinaryStatus } from "./types.js";

const CANDIDATES = ["omp"] as const;
const MAX_FAILURE_DETAIL_LENGTH = 180;

function buildCandidates(binaryPath?: string): { candidates: string[]; configuredBinaryPath?: string } {
  /*
  FNXC:OmpAcp 2026-07-11-23:35:
  Manual operator paths must be tried before PATH candidates without deleting
  the fallback order. Deduping keeps an `omp` override from probing twice.
  */
  const configuredBinaryPath = binaryPath?.trim() || undefined;
  const ordered = configuredBinaryPath ? [configuredBinaryPath, ...CANDIDATES] : [...CANDIDATES];
  return { candidates: Array.from(new Set(ordered)), configuredBinaryPath };
}

function summarizeFailure(binary: string, stdout: string, stderr: string): string | undefined {
  const detail = `${stderr || stdout}`.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  const truncated =
    detail.length > MAX_FAILURE_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…`
      : detail;
  return `${binary}: ${truncated}`;
}

export async function probeOmpBinary(options?: {
  timeoutMs?: number;
  binaryPath?: string;
}): Promise<OmpBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 3000;
  const { candidates, configuredBinaryPath } = buildCandidates(options?.binaryPath);
  const failureDetails: string[] = [];

  for (const binary of candidates) {
    const version = await runOmpCommand(binary, ["--version"], timeoutMs);
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
      // FNXC:OmpAcp 2026-07-11-23:35: readiness = binary available; omp owns auth (~/.omp).
      return {
        available: true,
        authenticated: true,
        ...common,
        version: version.stdout.trim() || version.stderr.trim() || undefined,
        reason: undefined,
      };
    }
  }

  const baseReason = configuredBinaryPath
    ? `Configured OMP CLI binary '${configuredBinaryPath}' failed; PATH fallback omp also failed`
    : "omp not found on PATH";
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
