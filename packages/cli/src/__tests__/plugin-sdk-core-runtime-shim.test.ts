import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

import { superviseSpawn } from "../plugin-sdk-core-runtime-shim.mjs";

class FakeChild extends EventEmitter {
  pid = 1234;
  kill = vi.fn();
}

describe("plugin SDK core runtime shim supervision", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("absorbs child spawn errors without throwing", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    superviseSpawn("missing-command");

    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
  });

  it("unrefs escalation timers and never SIGKILLs a closed child", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const timerCallbacks: Array<() => void> = [];
    const timerUnrefs: Array<ReturnType<typeof vi.fn>> = [];

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      timerCallbacks.push(callback);
      const timer = { unref: vi.fn() };
      timerUnrefs.push(timer.unref);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const supervised = superviseSpawn("command", [], { maxLifetimeMs: 10 });
    supervised.kill();
    timerCallbacks[0]!();
    child.emit("close", 0, null);
    timerCallbacks[1]!();
    timerCallbacks[2]!();

    expect(timerUnrefs).toHaveLength(3);
    expect(timerUnrefs.every((unref) => unref.mock.calls.length === 1)).toBe(true);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
});
