import { AgentStore, AGENT_VALID_TRANSITIONS } from "@fusion/core";
import type { AgentState } from "@fusion/core";
import { resolveAgentStoreBase } from "../project-context.js";

/**
 * Create an initialized AgentStore for the given project.
 *
 * FNXC:PostgresCutover 2026-07-04: borrow the PostgreSQL AsyncDataLayer from
 * the resolved project store so AgentStore runs in backend mode (the SQLite
 * runtime was removed under VAL-REMOVAL-005), mirroring extension.ts getAgentStore.
 */
async function createAgentStore(projectName?: string): Promise<{ store: AgentStore; cleanup: () => Promise<void> }> {
  const base = await resolveAgentStoreBase(projectName);
  const agentStore = new AgentStore({ rootDir: base.rootDir + "/.fusion", asyncLayer: base.asyncLayer });
  try {
    await agentStore.init();
    return { store: agentStore, cleanup: base.cleanup };
  } catch (error) {
    closeAgentStoreSafely(agentStore);
    await base.cleanup();
    throw error;
  }
}

/**
 * FNXC:CliAgentControl 2026-07-08-00:00:
 * Close the AgentStore best-effort, tolerating a store that is already
 * closed (or was never fully opened). `AgentStore.close()` already tolerates
 * a "database is not open" error internally; this wrapper additionally
 * guards against any other unexpected close-time error so a teardown failure
 * never masks the command's real result or blocks process exit.
 */
function closeAgentStoreSafely(agentStore: AgentStore): void {
  try {
    agentStore.close();
  } catch {
    // Best-effort teardown — never let a close failure block exit.
  }
}

/**
 * FNXC:CliAgentControl 2026-07-08-00:00:
 * Root cause of FN-7704: `fn agent stop`/`fn agent start` did their state
 * transition correctly but the CLI process never exited on its own —
 * `resolveProject()` cached an unclosed `TaskStore` and `createAgentStore()`
 * never closed the `AgentStore` it opened (see `agentStoreDbCache` in
 * @fusion/core's agent-store.ts). SQLite-level blocking is already bounded
 * (`busy_timeout` = 5s + a ~1s lock-recovery window in packages/core/src/db.ts),
 * so the previously observed 60s hang was the CALLER's subprocess timeout,
 * not a DB lock — the command's work finished, but a lingering handle kept
 * the event loop alive so the process never exited, and a recovery watcher
 * driving these commands as subprocesses would force-kill every single
 * retry at the same 60s ceiling, blocking recovery entirely.
 *
 * The fix has two parts, both implemented in this file:
 *   1. Deterministic teardown — close the `AgentStore` (via
 *      `closeAgentStoreSafely`) on EVERY exit path (success, already-in-
 *      target-state, not-found, invalid-transition, and unexpected error),
 *      and resolve the project path without leaking a `TaskStore` at all
 *      (`resolveProjectPathOnly` in project-context.ts).
 *   2. A bounded fast-fail guard (`withBoundedTimeout`) around the store
 *      mutation itself, so that if the operation genuinely cannot complete
 *      quickly the CLI fails fast with a clear, actionable error and a
 *      non-zero exit instead of hanging until an external caller kills it.
 *      The default deadline is intentionally short relative to the 60s
 *      caller-side ceiling this bug was measured against, and is
 *      operator-overridable via `FUSION_AGENT_CMD_TIMEOUT_MS` for
 *      constrained environments.
 */
const DEFAULT_AGENT_CMD_TIMEOUT_MS = 10_000;

function getAgentCmdTimeoutMs(): number {
  const raw = process.env.FUSION_AGENT_CMD_TIMEOUT_MS;
  if (!raw) return DEFAULT_AGENT_CMD_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_CMD_TIMEOUT_MS;
}

/** Raised when a store mutation exceeds the bounded fast-fail deadline. */
export class AgentCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCommandTimeoutError";
  }
}

/**
 * Race a store mutation against a bounded deadline so a stuck/contended
 * operation fails fast with a clear error instead of hanging the CLI
 * process. See the FNXC:CliAgentControl block above for rationale.
 */
async function withBoundedTimeout<T>(
  operation: () => Promise<T>,
  context: { id: string; action: string },
): Promise<T> {
  const timeoutMs = getAgentCmdTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new AgentCommandTimeoutError(
              `Timed out after ${timeoutMs}ms waiting for agent ${context.id} to ${context.action}. ` +
                `The operation may still complete in the background; retry, or increase the deadline via FUSION_AGENT_CMD_TIMEOUT_MS.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop (pause) a running agent.
 * Transitions state from running/active to paused.
 *
 * Note: Agent `metadata.skills` (array of skill names) controls which skills
 * are injected into the agent session at execution time when the agent is
 * assigned to a task. Skills are resolved by `buildSessionSkillContext`.
 */
export async function runAgentStop(id: string, projectName?: string): Promise<void> {
  const owned = await createAgentStore(projectName);
  const agentStore = owned.store;

  async function exitWithStore(code: number): Promise<never> {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
    return process.exit(code);
  }

  try {
    const agent = await agentStore.getAgent(id);
    if (!agent) {
      console.error(`Agent ${id} not found`);
      return await exitWithStore(1);
    }

    // Already paused — nothing to do
    if (agent.state === "paused") {
      console.log();
      console.log(`  Agent ${id} is already paused`);
      console.log();
      return;
    }

    // Validate transition locally
    const validTargets = AGENT_VALID_TRANSITIONS[agent.state as AgentState];
    if (!validTargets || !validTargets.includes("paused")) {
      console.error(`Cannot stop agent ${id} — current state '${agent.state}' cannot transition to 'paused'`);
      return await exitWithStore(1);
    }

    try {
      // FNXC:AgentLifecyclePause 2026-07-19-00:00: CLI stop mutates only the
      // agent row. It must not cascade to an assigned task's user/system pause.
      await withBoundedTimeout(() => agentStore.updateAgentState(id, "paused"), { id, action: "stop (transition to paused)" });
    } catch (err) {
      console.error(`Failed to stop agent ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return await exitWithStore(1);
    }

    console.log();
    console.log(`  ✓ Agent ${id} stopped`);
    console.log();
  } finally {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
  }
}

/**
 * Start (resume) a stopped/paused agent.
 * Transitions state from paused to active.
 */
export async function runAgentStart(id: string, projectName?: string): Promise<void> {
  const owned = await createAgentStore(projectName);
  const agentStore = owned.store;

  async function exitWithStore(code: number): Promise<never> {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
    return process.exit(code);
  }

  try {
    const agent = await agentStore.getAgent(id);
    if (!agent) {
      console.error(`Agent ${id} not found`);
      return await exitWithStore(1);
    }

    // Already active/running — nothing to do
    if (agent.state === "active" || agent.state === "running") {
      console.log();
      console.log(`  Agent ${id} is already running (${agent.state})`);
      console.log();
      return;
    }

    // Validate transition locally
    const validTargets = AGENT_VALID_TRANSITIONS[agent.state as AgentState];
    if (!validTargets || !validTargets.includes("active")) {
      console.error(`Cannot start agent ${id} — current state '${agent.state}' cannot transition to 'active'`);
      return await exitWithStore(1);
    }

    try {
      // FNXC:AgentLifecyclePause 2026-07-19-00:00: CLI start is not task
      // unpause; assigned-task pause ownership remains independent.
      await withBoundedTimeout(() => agentStore.updateAgentState(id, "active"), { id, action: "start (transition to active)" });
    } catch (err) {
      console.error(`Failed to start agent ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return await exitWithStore(1);
    }

    console.log();
    console.log(`  ✓ Agent ${id} started`);
    console.log();
  } finally {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
  }
}
