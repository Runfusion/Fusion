import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createLogger,
  schedulerLog,
  executorLog,
  triageLog,
  mergerLog,
  worktreePoolLog,
  reviewerLog,
  remoteNodeLog,
} from "./logger.js";

describe("createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("formats log output as [prefix] message on stderr", () => {
    const logger = createLogger("test");
    logger.log("hello world");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[test] hello world");
  });

  it("formats warn output as [prefix] message", () => {
    const logger = createLogger("test");
    logger.warn("something happened");
    expect(warnSpy).toHaveBeenCalledWith("[test] something happened");
  });

  it("formats error output as [prefix] message", () => {
    const logger = createLogger("test");
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledWith("[test] failure");
  });

  it("passes extra arguments through", () => {
    const logger = createLogger("test");
    const err = new Error("boom");
    logger.error("failed:", err);
    expect(errorSpy).toHaveBeenCalledWith("[test] failed:", err);
  });

  it("keeps log output off stdout", () => {
    const logger = createLogger("x");
    logger.log("a");
    logger.warn("b");
    logger.error("c");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("pre-built instances use correct prefixes", () => {
    schedulerLog.log("tick");
    expect(errorSpy).toHaveBeenCalledWith("[scheduler] tick");

    executorLog.log("run");
    expect(errorSpy).toHaveBeenCalledWith("[executor] run");

    triageLog.log("spec");
    expect(errorSpy).toHaveBeenCalledWith("[triage] spec");

    mergerLog.log("merge");
    expect(errorSpy).toHaveBeenCalledWith("[merger] merge");

    worktreePoolLog.log("prune");
    expect(errorSpy).toHaveBeenCalledWith("[worktree-pool] prune");

    reviewerLog.log("review");
    expect(errorSpy).toHaveBeenCalledWith("[reviewer] review");

    remoteNodeLog.log("stream");
    expect(errorSpy).toHaveBeenCalledWith("[remote-node] stream");
  });
});
