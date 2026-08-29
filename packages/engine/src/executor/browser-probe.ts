/**
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Agent-browser availability probe helpers peeled from executor.ts so the
 * monofile shrinks without changing browser-verification behavior.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SkillSelectionContext } from "../cli-runtime/skill-resolver.js";

const execAsync = promisify(exec);

export const AGENT_BROWSER_NAVIGATION_SKILL_ID = "agent-browser-navigation";

export interface AgentBrowserAvailabilityProbeResult {
  available: boolean;
  version?: string;
  reason?: string;
}

export type AgentBrowserExec = (
  command: string,
  options: { encoding: BufferEncoding; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

function isAgentBrowserNotFoundError(error: unknown): boolean {
  const err = error as { code?: unknown; stderr?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" || typeof err?.code === "number" ? String(err.code) : undefined;
  if (code === "ENOENT" || code === "127") return true;
  const combined = `${typeof err?.stderr === "string" ? err.stderr : ""}\n${typeof err?.message === "string" ? err.message : ""}`.toLowerCase();
  return combined.includes("agent-browser") && (combined.includes("not found") || combined.includes("command not found"));
}

function isAgentBrowserProbeTimeout(error: unknown): boolean {
  const err = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown } | null;
  return err?.code === "ETIMEDOUT"
    || err?.killed === true
    || err?.signal === "SIGTERM"
    || (typeof err?.message === "string" && err.message.toLowerCase().includes("timed out"));
}

/**
 * Probe the agent-browser CLI without making browser verification fatal.
 *
 * FNXC:WorkflowBrowserVerification 2026-06-27-13:20:
 * Browser Verification needs an actionable signal when `agent-browser` is absent or hung. Keep this async, bounded, and injectable so the executor logs availability without blocking or requiring the plugin at import time.
 */
export async function probeAgentBrowserAvailability(
  execImpl: AgentBrowserExec = execAsync as AgentBrowserExec,
  opts?: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<AgentBrowserAvailabilityProbeResult> {
  try {
    const { stdout, stderr } = await execImpl("agent-browser --version", {
      encoding: "utf-8",
      timeout: Math.min(Math.max(opts?.timeoutMs ?? 5_000, 1_000), 10_000),
      maxBuffer: opts?.maxBuffer ?? 64 * 1024,
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    const version = (stdout.trim() || stderr.trim() || "unknown").split("\n")[0]?.trim() || "unknown";
    return { available: true, version };
  } catch (error) {
    if (isAgentBrowserNotFoundError(error)) {
      return { available: false, reason: "not installed" };
    }
    if (isAgentBrowserProbeTimeout(error)) {
      return { available: false, reason: "probe timed out" };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason };
  }
}

/** Merge the agent-browser navigation skill into a workflow-step session. */
export function augmentSessionSkillsForBrowserStep(
  skillSelection: SkillSelectionContext | undefined,
  projectRootDir: string,
): SkillSelectionContext {
  const existing = skillSelection?.requestedSkillNames ?? [];
  return {
    projectRootDir: skillSelection?.projectRootDir ?? projectRootDir,
    sessionPurpose: skillSelection?.sessionPurpose ?? "executor",
    requestedSkillNames: [...new Set([...existing, AGENT_BROWSER_NAVIGATION_SKILL_ID])],
  };
}

export function formatAgentBrowserAvailabilityLog(result: AgentBrowserAvailabilityProbeResult): string {
  if (result.available) {
    return `[browser-verification] agent-browser available — version ${result.version ?? "unknown"}`;
  }
  if (result.reason === "probe timed out") {
    return "[browser-verification] agent-browser availability probe timed out — the step relies on the agent-browser CLI; continuing so the step can fast-bail or report its own failure.";
  }
  return "[browser-verification] agent-browser not found on PATH — the step relies on the agent-browser CLI; install the agent-browser plugin/binary. Continuing; the step may fast-bail or fail.";
}
