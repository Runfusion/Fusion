import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../logger.js";

/*
FNXC:EngineDiagnostics 2026-07-15-12:55:
Guards the contract that keeps steady-state scheduler chatter out of the operator log pane: `debug()` is silent unless the subsystem opted in via `FUSION_DEBUG`, and `log()` is never gated.
A regression either way is invisible in normal use — it either re-floods the TUI or silently swallows real events — so it is asserted rather than eyeballed.
*/
describe("createLogger debug gating", () => {
  afterEach(() => {
    delete process.env.FUSION_DEBUG;
    vi.restoreAllMocks();
  });

  it("suppresses debug output when FUSION_DEBUG is unset", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("scheduler").debug("steady-state chatter");
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits debug output for a subsystem named in the FUSION_DEBUG list", () => {
    process.env.FUSION_DEBUG = "scheduler,merger";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("scheduler").debug("steady-state chatter");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("[scheduler] steady-state chatter");
  });

  it("suppresses debug output for a subsystem absent from the FUSION_DEBUG list", () => {
    process.env.FUSION_DEBUG = "merger";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("scheduler").debug("steady-state chatter");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "all", "*"])("emits debug output for every subsystem when FUSION_DEBUG=%s", (value) => {
    process.env.FUSION_DEBUG = value;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("scheduler").debug("steady-state chatter");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("re-reads FUSION_DEBUG per call so toggling does not require a new logger", () => {
    const log = createLogger("scheduler");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.debug("first");
    expect(spy).not.toHaveBeenCalled();
    process.env.FUSION_DEBUG = "scheduler";
    log.debug("second");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("never gates log/warn/error on FUSION_DEBUG", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createLogger("scheduler");
    log.log("real event");
    log.warn("real warning");
    log.error("real failure");
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
