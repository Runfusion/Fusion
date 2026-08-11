import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger.js";
import { createRepeatSuppressedLog } from "../repeat-suppressed-log.js";
import {
  clearDispatchBlockedLogState,
  logDispatchBlockedOnce,
  resetDispatchBlockedLogState,
} from "../../executor/dispatch-block-log.js";

/*
FNXC:EngineDiagnostics 2026-08-10-08:59:
The executor's pre-dispatch gates re-run on every dispatch attempt for a blocked task and used to re-log the same
"executor dispatch blocked" line each pass, flooding the default-level TUI log pane. The invariant asserted here is
per-signature, not per-call-site: the FIRST occurrence logs at `log()`/`warn()`, identical repeats drop to `debug()`, a
CHANGED reason logs again (operators must still see transitions), and clearing the state after the condition resolves
restores full level for the next occurrence.

FNXC:EngineDiagnostics 2026-08-10-17:13:
Same mechanism now backs the scheduler's symbol-lock renewal, where a persistent loss also drove a per-poll
`store.logEntry` append — hence the `logOnce` return value, which callers use to gate that companion write.
*/
function createFakeLogger(): Logger & Record<"log" | "debug" | "warn" | "error", ReturnType<typeof vi.fn>> {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & Record<"log" | "debug" | "warn" | "error", ReturnType<typeof vi.fn>>;
}

describe("createRepeatSuppressedLog", () => {
  it("logs the first occurrence and demotes identical repeats to debug", () => {
    const suppressed = createRepeatSuppressedLog();
    const logger = createFakeLogger();

    const appended = [...Array(5)].map(() => suppressed.logOnce(logger, "FN-1", "dependencies:FN-PARENT", "FN-1: blocked"));

    expect(appended).toEqual([true, false, false, false, false]);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith("FN-1: blocked");
    expect(logger.debug).toHaveBeenCalledTimes(4);
  });

  it("logs again when the signature changes", () => {
    const suppressed = createRepeatSuppressedLog();
    const logger = createFakeLogger();

    suppressed.logOnce(logger, "FN-1", "lost:a", "FN-1: lost a", "warn");
    suppressed.logOnce(logger, "FN-1", "lost:a", "FN-1: lost a", "warn");
    suppressed.logOnce(logger, "FN-1", "lost:a,b", "FN-1: lost a, b", "warn");

    expect(logger.warn.mock.calls.map((call) => call[0])).toEqual(["FN-1: lost a", "FN-1: lost a, b"]);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("keeps signatures per key so one stuck task does not silence another", () => {
    const suppressed = createRepeatSuppressedLog();
    const logger = createFakeLogger();

    suppressed.logOnce(logger, "FN-1", "ephemeral-disabled", "FN-1: blocked");
    suppressed.logOnce(logger, "FN-2", "ephemeral-disabled", "FN-2: blocked");

    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("reports at full level again after the condition resolves and the key is cleared", () => {
    const suppressed = createRepeatSuppressedLog();
    const logger = createFakeLogger();

    suppressed.logOnce(logger, "FN-1", "ephemeral-disabled", "FN-1: blocked");
    suppressed.logOnce(logger, "FN-1", "ephemeral-disabled", "FN-1: blocked");
    suppressed.clear("FN-1");
    const appended = suppressed.logOnce(logger, "FN-1", "ephemeral-disabled", "FN-1: blocked");

    expect(appended).toBe(true);
    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("keeps instances independent so subsystems cannot collide on the same key", () => {
    const executorSuppressed = createRepeatSuppressedLog();
    const schedulerSuppressed = createRepeatSuppressedLog();
    const logger = createFakeLogger();

    executorSuppressed.logOnce(logger, "FN-1", "blocked", "executor");
    schedulerSuppressed.logOnce(logger, "FN-1", "blocked", "scheduler");

    expect(logger.log).toHaveBeenCalledTimes(2);
  });
});

describe("executor dispatch-block log instance", () => {
  it("suppresses repeats and re-reports after the gate passes", () => {
    resetDispatchBlockedLogState();
    const logger = createFakeLogger();

    logDispatchBlockedOnce(logger, "FN-1", "dependencies:FN-PARENT", "FN-1: blocked");
    logDispatchBlockedOnce(logger, "FN-1", "dependencies:FN-PARENT", "FN-1: blocked");
    clearDispatchBlockedLogState("FN-1");
    logDispatchBlockedOnce(logger, "FN-1", "dependencies:FN-PARENT", "FN-1: blocked");

    expect(logger.log).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
