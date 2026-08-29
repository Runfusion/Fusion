import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../process/logger.js";

describe("core createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalDebug = process.env.FUSION_DEBUG;

  beforeEach(() => {
    delete process.env.FUSION_DEBUG;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.FUSION_DEBUG;
    else process.env.FUSION_DEBUG = originalDebug;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits info logs to stderr with an info severity marker", () => {
    const logger = createLogger("core-test");
    logger.log("hello");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=info\u0000[core-test] hello");
  });

  it("emits warn logs with a warn severity marker", () => {
    const logger = createLogger("core-test");
    logger.warn("careful");

    expect(warnSpy).toHaveBeenCalledWith("\u0000fnlvl=warn\u0000[core-test] careful");
  });

  it("emits error logs with an error severity marker", () => {
    const logger = createLogger("core-test");
    const err = new Error("boom");
    logger.error("broken", err);

    expect(errorSpy).toHaveBeenCalledWith("\u0000fnlvl=error\u0000[core-test] broken", err);
  });

  /*
  FNXC:EngineDiagnostics 2026-07-26-09:45:
  process-supervisor spawn chatter depends on debug gating; lock the contract here so TUI spam cannot regress.
  */
  it("suppresses debug output when FUSION_DEBUG is unset", () => {
    const logger = createLogger("process-supervisor");
    logger.debug("spawned pid=123 pgid=123 command=pnpm test");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("emits debug when FUSION_DEBUG names the subsystem", () => {
    process.env.FUSION_DEBUG = "process-supervisor";
    const logger = createLogger("process-supervisor");
    logger.debug("spawned pid=123 pgid=123 command=pnpm test");
    expect(errorSpy).toHaveBeenCalledWith(
      "\u0000fnlvl=info\u0000[process-supervisor] spawned pid=123 pgid=123 command=pnpm test",
    );
  });

  it("emits debug for every subsystem when FUSION_DEBUG=all", () => {
    process.env.FUSION_DEBUG = "all";
    const logger = createLogger("process-supervisor");
    logger.debug("child pid=123 exited naturally code=0 signal=null");
    expect(errorSpy).toHaveBeenCalled();
  });
});
