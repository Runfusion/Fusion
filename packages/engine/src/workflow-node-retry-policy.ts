export interface WorkflowRetryState {
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  maxAttempts: number;
  retryAfter: string | null;
  exhausted: boolean;
  lastError: string | null;
}

export interface WorkflowRetryPolicyInput {
  runId: string;
  taskId: string;
  nodeId: string;
  attempt?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  now?: string;
  fallbackNowMs?: number;
  lastError?: string | null;
}

export function nextWorkflowRetryState(input: WorkflowRetryPolicyInput): WorkflowRetryState {
  const attempt = Math.max(0, Math.floor(input.attempt ?? 0)) + 1;
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3));
  const exhausted = attempt >= maxAttempts;
  const parsedNowMs = Date.parse(input.now ?? new Date().toISOString());
  const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : input.fallbackNowMs ?? Date.now();
  const baseDelayMs = Math.max(1_000, Math.floor(input.baseDelayMs ?? 30_000));
  const maxDelayMs = 24 * 60 * 60_000;
  const delayMs = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);

  return {
    runId: input.runId,
    taskId: input.taskId,
    nodeId: input.nodeId,
    attempt,
    maxAttempts,
    retryAfter: exhausted ? null : new Date(nowMs + delayMs).toISOString(),
    exhausted,
    lastError: input.lastError ?? null,
  };
}

export function workflowRetryContextPatch(state: WorkflowRetryState): Record<string, unknown> {
  return {
    [`workflow:retry:${state.nodeId}:attempt`]: state.attempt,
    [`workflow:retry:${state.nodeId}:maxAttempts`]: state.maxAttempts,
    [`workflow:retry:${state.nodeId}:retryAfter`]: state.retryAfter,
    [`workflow:retry:${state.nodeId}:exhausted`]: state.exhausted,
    [`workflow:retry:${state.nodeId}:lastError`]: state.lastError,
  };
}
