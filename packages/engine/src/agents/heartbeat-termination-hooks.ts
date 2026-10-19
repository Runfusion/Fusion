import type { AgentSession } from "@earendil-works/pi-coding-agent";

export class HeartbeatTerminationRequestedError extends Error {
  constructor() {
    super("Heartbeat termination requested before model dispatch");
    this.name = "HeartbeatTerminationRequestedError";
  }
}

type Session = { agent?: Pick<AgentSession["agent"], "finishTurn" | "prepareRequest"> };
type TurnDecision = Extract<Awaited<ReturnType<NonNullable<AgentSession["agent"]["finishTurn"]>>>, object>;
type RequestUpdate = Extract<Awaited<ReturnType<NonNullable<AgentSession["agent"]["prepareRequest"]>>>, object>;

/**
FNXC:HeartbeatTermination 2026-10-19-09:10:
Terminal intent must close dispatch even while no abortable replacement session is bound.
Preserve the SDK's hooks and enforce the monitor's existing latch at turn/request boundaries.
Check again after asynchronous preparation: cancellation may arrive while that hook is pending.
*/
export function installHeartbeatTerminationHooks(session: Session, shouldStop: () => boolean): void {
  const agent = session.agent;
  if (!agent) return; // Other runtime adapters retain the existing monitor abort/event fences.
  const previousFinishTurn = agent.finishTurn;
  agent.finishTurn = async (turn, signal): Promise<TurnDecision | undefined> => {
    const previous = (await previousFinishTurn?.(turn, signal)) as TurnDecision | undefined;
    if (previous?.action === "end") return previous;
    if (shouldStop() || signal?.aborted) return { action: "end" };
    return previous;
  };
  const previousPrepareRequest = agent.prepareRequest;
  agent.prepareRequest = async (request, signal): Promise<RequestUpdate | undefined> => {
    if (shouldStop() || signal?.aborted) throw new HeartbeatTerminationRequestedError();
    const previous = await previousPrepareRequest?.(request, signal);
    if (shouldStop() || signal?.aborted) throw new HeartbeatTerminationRequestedError();
    return (previous ?? undefined) as RequestUpdate | undefined;
  };
}

/** FNXC:HeartbeatTermination 2026-10-19-11:20: Keep genuine failures visible even if a credential rotation already in flight re-enters. */
export function createHeartbeatPromptAttemptRunner(shouldStop: () => boolean) {
  let failure: unknown;
  let failed = false;
  return async (prompt: () => Promise<void>): Promise<void> => {
    if (failed && shouldStop()) throw failure;
    try {
      await prompt();
    } catch (error) {
      const expected = error instanceof HeartbeatTerminationRequestedError
        || (error instanceof Error && error.name === "AbortError");
      if (shouldStop() && expected) return;
      failed = true;
      failure = error;
      throw error;
    }
  };
}
