import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadDiagnosticsModule() {
  return import("../roomOpenDiagnostics");
}

describe("roomOpenDiagnostics", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not emit logs when gate is off", async () => {
    vi.stubEnv("DEV", "");
    vi.resetModules();
    vi.stubGlobal("performance", { now: vi.fn(() => 10) });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { startRoomOpenTimer } = await loadDiagnosticsModule();

    const timer = startRoomOpenTimer("room-a", { warm: false });
    timer.mark("select");
    timer.complete();

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("emits phased timing when localStorage debug gate is on", async () => {
    localStorage.setItem("kb-debug-room-open", "1");
    let tick = 0;
    vi.stubGlobal("performance", {
      now: vi.fn(() => {
        tick += 25;
        return tick;
      }),
    });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { startRoomOpenTimer } = await loadDiagnosticsModule();

    const timer = startRoomOpenTimer("room-a", { warm: true });
    timer.mark("select");
    timer.mark("cache-hit");
    timer.mark("messages-fetch");
    timer.complete({ fromReconnect: false });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      "[room-open]",
      expect.objectContaining({
        roomId: "room-a",
        warm: true,
        totalMs: expect.any(Number),
        phases: expect.objectContaining({
          select: 25,
          "cache-hit": 25,
          "messages-fetch": 25,
          complete: 25,
        }),
        fromReconnect: false,
      }),
    );
  });

  it("complete is idempotent", async () => {
    localStorage.setItem("kb-debug-room-open", "1");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { startRoomOpenTimer } = await loadDiagnosticsModule();

    const timer = startRoomOpenTimer("room-a");
    timer.mark("select");
    timer.complete();
    timer.mark("hydrate");
    timer.complete();

    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it("cancel suppresses log emission", async () => {
    localStorage.setItem("kb-debug-room-open", "1");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { startRoomOpenTimer } = await loadDiagnosticsModule();

    const timer = startRoomOpenTimer("room-a");
    timer.mark("select");
    timer.cancel();
    timer.complete();

    expect(debugSpy).not.toHaveBeenCalled();
  });
});
