import { describe, expect, it, vi } from "vitest";

import { _wrapSessionDisposeForTest } from "../pi.js";

describe("session shutdown dispose wrapper", () => {
  const createSession = (options?: { hasHandlers?: boolean; emitReject?: boolean }) => {
    const dispose = vi.fn();
    const hasHandlers = vi.fn(() => options?.hasHandlers ?? true);
    const emit = options?.emitReject
      ? vi.fn().mockRejectedValue(new Error("emit failed"))
      : vi.fn().mockResolvedValue(undefined);
    const extensionRunner = { hasHandlers, emit };
    const session = {
      extensionRunner,
      dispose,
    };
    return { session, dispose, extensionRunner, hasHandlers, emit };
  };

  it("emits session_shutdown once on dispose", async () => {
    const { session, dispose, extensionRunner, emit } = createSession();

    _wrapSessionDisposeForTest(session as any);
    await (session as any).dispose();

    expect(extensionRunner.hasHandlers).toHaveBeenCalledWith("session_shutdown");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across multiple dispose calls", async () => {
    const { session, dispose, emit } = createSession();

    _wrapSessionDisposeForTest(session as any);
    await (session as any).dispose();
    await (session as any).dispose();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not throw when shutdown emit fails", async () => {
    const { session, dispose } = createSession({ emitReject: true });

    _wrapSessionDisposeForTest(session as any);

    await expect((session as any).dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("runs dispose on no-handler fast path", async () => {
    const { session, dispose, emit, hasHandlers } = createSession({ hasHandlers: false });

    _wrapSessionDisposeForTest(session as any);
    await (session as any).dispose();

    expect(hasHandlers).toHaveBeenCalledWith("session_shutdown");
    expect(emit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
