import { runAntigravityCliCommand } from "./cli-spawn.js";
import type { AntigravityBinaryStatus } from "./types.js";

const MAX_DETAIL = 180;

/**
 * FNXC:AntigravityProbe 2026-09-20-19:17:
 * Readiness and model discovery share the supervised minimal-environment CLI
 * runner with MCP management, so a missing or hung binary cannot retain an
 * unbounded probe or inherit credentials from Fusion's parent process.
 */
export async function probeAntigravityBinary(options?: { binaryPath?: string; timeoutMs?: number }): Promise<AntigravityBinaryStatus> {
  const startedAt = Date.now();
  const configuredBinaryPath = options?.binaryPath?.trim() || undefined;
  const binary = configuredBinaryPath ?? "agy";
  const result = await runAntigravityCliCommand(binary, ["--version"], options?.timeoutMs ?? 3_000);
  const detail = `${result.stderr || result.stdout}`.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  if (result.code !== 0) return { available: false, authenticated: false, binaryName: binary, binaryPath: binary, configuredBinaryPath, usingConfiguredBinaryPath: Boolean(configuredBinaryPath), reason: configuredBinaryPath ? "Configured Antigravity binary is unavailable." : "agy was not found on PATH.", diagnostics: detail ? [detail] : undefined, probeDurationMs: Date.now() - startedAt };
  return { available: true, authenticated: undefined, binaryName: binary, binaryPath: binary, configuredBinaryPath, usingConfiguredBinaryPath: Boolean(configuredBinaryPath), version: result.stdout.trim() || undefined, probeDurationMs: Date.now() - startedAt };
}
export async function discoverAntigravityProviderModels(options?: { binaryPath?: string; timeoutMs?: number }) {
  const binary = options?.binaryPath?.trim() || "agy";
  const result = await runAntigravityCliCommand(binary, ["models"], options?.timeoutMs ?? 3_000);
  if (result.code !== 0) return { models: [], source: "agy models", fallbackUsed: true, reason: "model-discovery-failed" };
  const ids = Array.from(new Set(result.stdout.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter((line) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(line))));
  return { models: ids.map((id) => ({ id, label: id })), source: "agy models", fallbackUsed: false };
}
