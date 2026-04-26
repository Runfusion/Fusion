import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createLogger,
  schedulerLog,
  executorLog,
  planLog,
  mergerLog,
  worktreePoolLog,
  reviewerLog,
  remoteNodeLog,
} from "../logger.js";

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
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[test] hello world");
  });

  it("formats warn output as [prefix] message", () => {
    const logger = createLogger("test");
    logger.warn("something happened");
    expect(warnSpy).toHaveBeenCalledWith("\u0000fnlvl=warn\u0000[test] something happened");
  });

  it("formats error output as [prefix] message", () => {
    const logger = createLogger("test");
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=error\u0000[test] failure");
  });

  it("passes extra arguments through", () => {
    const logger = createLogger("test");
    const err = new Error("boom");
    logger.error("failed:", err);
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=error\u0000[test] failed:", err);
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
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[scheduler] tick");

    executorLog.log("run");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[executor] run");

    planLog.log("spec");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[plan] spec");

    mergerLog.log("merge");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[merger] merge");

    worktreePoolLog.log("prune");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[worktree-pool] prune");

    reviewerLog.log("review");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[reviewer] review");

    remoteNodeLog.log("stream");
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[remote-node] stream");
  });
});
