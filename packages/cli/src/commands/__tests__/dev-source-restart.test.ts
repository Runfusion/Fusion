import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEV_SOURCE_CHANGE_MESSAGE,
  registerDevSourceRestart,
} from "../dev-source-restart.js";

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(currentlyActive: number) {
  const processEvents = new EventEmitter();
  const getLiveRunningAgentCounts = vi.fn().mockResolvedValue({ currentlyActive, projectsActive: {} });
  const beginDrain = vi.fn();
  const requestRestart = vi.fn().mockReturnValue(true);
  const log = vi.fn();
  const warn = vi.fn();
  const notifyArmed = vi.fn();
  const dispose = registerDevSourceRestart({
    enabled: true,
    processEvents,
    beginDrain,
    notifyArmed,
    getLiveRunningAgentCounts,
    requestRestart,
    logger: { log, warn },
    recheckIntervalMs: 1_000,
  });
  return { processEvents, beginDrain, notifyArmed, getLiveRunningAgentCounts, requestRestart, log, warn, dispose };
}

describe("registerDevSourceRestart", () => {
  it("acknowledges that the child restart listener is armed", () => {
    const harness = createHarness(0);
    expect(harness.notifyArmed).toHaveBeenCalledOnce();
    harness.dispose();
  });

  it("requests the canonical restart immediately when no agents are active", async () => {
    vi.useFakeTimers();
    const harness = createHarness(0);

    harness.processEvents.emit("message", {
      type: DEV_SOURCE_CHANGE_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.beginDrain.mock.invocationCallOrder[0]).toBeLessThan(
      harness.getLiveRunningAgentCounts.mock.invocationCallOrder[0]!,
    );
    expect(harness.getLiveRunningAgentCounts).toHaveBeenCalledTimes(1);
    expect(harness.requestRestart).toHaveBeenCalledWith("dev-source-change");
    harness.dispose();
  });

  it("coalesces edits and waits for active agents to reach a safe boundary", async () => {
    vi.useFakeTimers();
    const harness = createHarness(2);

    harness.processEvents.emit("message", { type: DEV_SOURCE_CHANGE_MESSAGE });
    harness.processEvents.emit("message", { type: DEV_SOURCE_CHANGE_MESSAGE });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.getLiveRunningAgentCounts).toHaveBeenCalledTimes(1);
    expect(harness.requestRestart).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("2 active agents"));

    harness.getLiveRunningAgentCounts.mockResolvedValue({ currentlyActive: 0, projectsActive: {} });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.requestRestart).toHaveBeenCalledTimes(1);
    expect(harness.requestRestart).toHaveBeenCalledWith("dev-source-change");
    harness.dispose();
  });

  it("recovers from a liveness read error and retries after the drain is closed", async () => {
    vi.useFakeTimers();
    const harness = createHarness(0);
    harness.getLiveRunningAgentCounts.mockRejectedValueOnce(new Error("database unavailable"));

    harness.processEvents.emit("message", { type: DEV_SOURCE_CHANGE_MESSAGE });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
    expect(harness.requestRestart).not.toHaveBeenCalled();

    harness.getLiveRunningAgentCounts.mockResolvedValueOnce({ currentlyActive: 0, projectsActive: {} });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.getLiveRunningAgentCounts).toHaveBeenCalledTimes(2);
    expect(harness.requestRestart).toHaveBeenCalledWith("dev-source-change");
    harness.dispose();
  });

  it("keeps the restart pending when the host initially declines it", async () => {
    vi.useFakeTimers();
    const harness = createHarness(0);
    harness.requestRestart.mockReturnValueOnce(false).mockReturnValueOnce(true);

    harness.processEvents.emit("message", { type: DEV_SOURCE_CHANGE_MESSAGE });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.requestRestart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.requestRestart).toHaveBeenCalledTimes(2);
    harness.dispose();
  });

  it("does not bind when the caller safety gate is disabled", () => {
    const processEvents = new EventEmitter();
    const requestRestart = vi.fn();
    const beginDrain = vi.fn();
    const getLiveRunningAgentCounts = vi.fn();

    const dispose = registerDevSourceRestart({
      enabled: false,
      processEvents,
      beginDrain,
      getLiveRunningAgentCounts,
      requestRestart,
    });
    processEvents.emit("message", { type: DEV_SOURCE_CHANGE_MESSAGE });

    expect(getLiveRunningAgentCounts).not.toHaveBeenCalled();
    expect(beginDrain).not.toHaveBeenCalled();
    expect(requestRestart).not.toHaveBeenCalled();
    dispose();
  });
});
