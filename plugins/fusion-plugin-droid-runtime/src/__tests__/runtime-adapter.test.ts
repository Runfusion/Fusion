import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../provider.js", () => ({
  streamViaCli: vi.fn(),
}));

import { streamViaCli } from "../provider.js";
import { DroidRuntimeAdapter } from "../runtime-adapter.js";

describe("DroidRuntimeAdapter", () => {
  it("createSession uses configured model and callbacks", async () => {
    const onText = vi.fn();
    const adapter = new DroidRuntimeAdapter({ droidModel: "droid-pro" });
    const result = await adapter.createSession({ cwd: process.cwd(), systemPrompt: "sys", onText });

    expect(result.session.model).toBe("droid-pro");
    expect(result.session.callbacks.onText).toBe(onText);
    expect(adapter.describeModel(result.session)).toBe("droid/droid-pro");
  });

  it("promptWithFallback forwards text/thinking deltas", async () => {
    const stream = new EventEmitter();
    const mockStreamViaCli = vi.mocked(streamViaCli);
    mockStreamViaCli.mockReturnValue(stream as any);

    const onText = vi.fn();
    const onThinking = vi.fn();
    const adapter = new DroidRuntimeAdapter({ droidModel: "droid-pro" });
    const { session } = await adapter.createSession({ cwd: process.cwd(), systemPrompt: "sys", onText, onThinking });

    const pending = adapter.promptWithFallback(session, "hello");
    stream.emit("text_delta", { text: "a" });
    stream.emit("thinking_delta", { text: "b" });
    stream.emit("done");
    await pending;

    expect(onText).toHaveBeenCalledWith("a");
    expect(onThinking).toHaveBeenCalledWith("b");
    expect(mockStreamViaCli).toHaveBeenCalledWith(
      expect.objectContaining({ id: "droid-pro", provider: "droid-cli" }),
      expect.objectContaining({ systemPrompt: "sys" }),
      expect.objectContaining({ sessionId: "" }),
    );
  });

  it("promptWithFallback resolves on stream error", async () => {
    const stream = new EventEmitter();
    vi.mocked(streamViaCli).mockReturnValue(stream as any);

    const adapter = new DroidRuntimeAdapter();
    const { session } = await adapter.createSession({ cwd: process.cwd(), systemPrompt: "sys", onText: vi.fn() });
    const pending = adapter.promptWithFallback(session, "hello");
    stream.emit("error", new Error("boom"));
    await expect(pending).resolves.toBeUndefined();
  });
});
