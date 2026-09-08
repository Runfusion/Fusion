import { describe, it, expect, vi, afterEach } from "vitest";
import { boundedPhaseTime, phaseTime, StartupPhaseTimeoutError } from "../startup-phase.js";

describe("phaseTime", () => {
  it("logs duration on success", async () => {
    const log = vi.fn();
    const result = await phaseTime("demo", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    }, log, "test");

    expect(result).toBe(42);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/^startup phase demo: \d+ms$/);
    expect(log.mock.calls[0][1]).toBe("test");
  });

  it("logs duration when the phase throws", async () => {
    const log = vi.fn();
    await expect(
      phaseTime("boom", async () => {
        throw new Error("nope");
      }, log),
    ).rejects.toThrow("nope");

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/^startup phase boom: \d+ms$/);
  });
});

describe("boundedPhaseTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the phase result and logs duration when it finishes inside the budget", async () => {
    const log = vi.fn();
    const result = await boundedPhaseTime("fast", async () => "ok", log, 60_000, "test");

    expect(result).toBe("ok");
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/^startup phase fast: \d+ms$/);
    expect(log.mock.calls[0][1]).toBe("test");
  });

  it("rejects once the budget elapses instead of waiting for a phase that never settles", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    // A phase that never settles is exactly the measured failure: discoverAndLoadExtensions
    // ran 399,809ms while the dashboard sat on "Loading extensions...".
    const pending = boundedPhaseTime("stuck", () => new Promise<string>(() => {}), log, 120_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(StartupPhaseTimeoutError);

    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/^startup phase stuck: \d+ms$/);
  });

  it("names the phase and budget in the timeout error so a slow boot is attributable", async () => {
    vi.useFakeTimers();
    const pending = boundedPhaseTime("discoverAndLoadExtensions", () => new Promise<void>(() => {}), vi.fn(), 120_000);
    const assertion = expect(pending).rejects.toThrow(
      "startup phase discoverAndLoadExtensions timed out after 120000ms",
    );

    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it("propagates a phase failure unchanged rather than reporting it as a timeout", async () => {
    const log = vi.fn();
    await expect(
      boundedPhaseTime("boom", async () => {
        throw new Error("nope");
      }, log, 60_000),
    ).rejects.toThrow("nope");

    expect(log).toHaveBeenCalledOnce();
  });

  it("keeps a late rejection observed so a phase that fails after the bound cannot go unhandled", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (err: Error) => void = () => {};
      const pending = boundedPhaseTime(
        "late",
        () => new Promise<void>((_, reject) => { rejectLate = reject; }),
        vi.fn(),
        1_000,
      );
      await expect((async () => {
        const assertion = expect(pending).rejects.toBeInstanceOf(StartupPhaseTimeoutError);
        await vi.advanceTimersByTimeAsync(1_000);
        await assertion;
      })()).resolves.toBeUndefined();

      rejectLate(new Error("phase failed after the bound"));
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
