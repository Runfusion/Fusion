/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * buildInjectedRuntimeEnv peeled from TaskExecutor (U4).
 *
 * Build task-scoped runtime env carrying plugin-injected keys plus PATH contribution.
 * Never mutates process.env globally — scoped env is threaded through taskEnv.
 */
import { delimiter } from "node:path";
import { createFusionBrowserLease } from "../agent-browser-lifecycle.js";

export type BuildInjectedRuntimeEnvDeps = {
  rootDir: string;
  collectExecutorRuntimeEnv?: (input: {
    taskId: string;
    worktreePath: string;
    rootDir: string;
    branch: string | undefined;
  }) => Promise<{ env?: NodeJS.ProcessEnv; pathPrepend?: string[] } | undefined | null> | undefined;
};

export async function buildInjectedRuntimeEnv(
  deps: BuildInjectedRuntimeEnvDeps,
  taskId: string,
  worktreePath: string,
  branch: string | undefined,
): Promise<{ env: NodeJS.ProcessEnv; injectedKeyCount: number; pathEntryCount: number }> {
  const runtimeEnvContribution = await deps.collectExecutorRuntimeEnv?.({
    taskId,
    worktreePath,
    rootDir: deps.rootDir,
    branch,
  });
  const pathPrepend = runtimeEnvContribution?.pathPrepend ?? [];
  const injectedEnv = runtimeEnvContribution?.env ?? {};
  const baseEnv = {
    ...process.env,
    ...injectedEnv,
    PATH: [...pathPrepend, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
  /*
  FNXC:AgentBrowserOwnership 2026-09-20-00:56:
  Every actual executor environment receives one opaque browser lease. The native
  daemon has no parent watchdog; this lease and its enforced positive idle timeout
  make a SIGKILL survivor attributable to Fusion recovery without affecting probes.
  */
  const browser = createFusionBrowserLease(taskId, baseEnv);
  return {
    env: browser.env,
    injectedKeyCount: Object.keys(injectedEnv).length,
    pathEntryCount: pathPrepend.length,
  };
}
