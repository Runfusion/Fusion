import { expect, type Mock } from "vitest";

/**
 * FNXC:AgentLogging 2026-07-07-08:10:
 * FN-7503 added optional timing telemetry (`durationMs`/`timeToFirstTokenMs`) as a
 * 6th positional argument to `TaskStore.appendAgentLog` for entries that carry
 * timing (text/tool_result/tool_error with measured metrics). Calls without timing
 * still pass only five args, so the 6th is genuinely optional.
 *
 * Assertions on agent-log writes must pin the meaningful first five positional args
 * (taskId/text/type/detail/agent) and stay tolerant of the optional timing object,
 * otherwise every executor/heartbeat/merger test re-breaks whenever a new timing
 * field is added. Use this helper instead of `toHaveBeenCalledWith(...)` for those
 * five-arg assertions. See `packages/engine/src/agent-logger.ts` flushPendingEntries.
 */
export function expectAppendAgentLog(
  mock: Mock,
  taskId: string,
  text: string,
  type: string,
  detail: unknown,
  agent: string,
): void {
  const calls = mock.mock.calls as unknown[][];
  const found = calls.some(
    (call) =>
      call[0] === taskId &&
      call[1] === text &&
      call[2] === type &&
      call[3] === detail &&
      call[4] === agent,
  );
  expect(
    found,
    `expected appendAgentLog to have been called with (${JSON.stringify(taskId)}, ${JSON.stringify(text)}, ${JSON.stringify(type)}, ${JSON.stringify(detail)}, ${JSON.stringify(agent)}) as its first five args (ignoring any optional timing object); actual calls were:\n${calls.map((c) => JSON.stringify(c)).join("\n")}`,
  ).toBe(true);
}
