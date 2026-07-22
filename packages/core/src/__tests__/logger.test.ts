import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../process/logger.js";

describe("core createLogger", () => {
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
});
