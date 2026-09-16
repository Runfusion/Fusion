import { describe, expect, it, vi } from "vitest";
import { createChatStreamHandlers } from "../createChatStreamHandlers";
import type { ToolCallInfo } from "../chatTypes";

describe("createChatStreamHandlers", () => {
  it.each([
    {
      name: "empty delta sandwiched between spaced chunks",
      chunks: ["Hello.", "", " World."],
      expected: "Hello. World.",
    },
    {
      name: "multiple sentence boundaries across four chunks",
      chunks: ["One.", " Two.", " Three.", " Four."],
      expected: "One. Two. Three. Four.",
    },
    {
      name: "whitespace-only final delta immediately before done",
      chunks: ["Trailing", " "],
      expected: "Trailing ",
    },
  ])("preserves whitespace across streamed text deltas (%s)", ({ chunks, expected }) => {
    vi.useFakeTimers();

    let text = "";
    const onDone = vi.fn();
    const onError = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1",
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone,
      onError,
    });

    for (const chunk of chunks) {
      handlers.onText(chunk);
    }

    vi.advanceTimersToNextTimer();

    expect(text).toBe(expected);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith({
      messageId: "m-1",
      message: undefined,
      accumulated: {
        text: expected,
        thinking: "",
        toolCalls: [],
        fallbackInfo: undefined,
      },
    });
    expect(onError).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("FN-6632 seeds reattached accumulators before appending new chunks", () => {
    vi.useFakeTimers();

    let text = "Hello ";
    let thinking = "thinking…";
    let toolCalls: ToolCallInfo[] = [
      { toolName: "read", status: "completed", isError: false, result: "seeded" },
    ];
    const onDone = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      initialText: "Hello ",
      initialThinking: "thinking…",
      initialToolCalls: toolCalls,
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: (value) => {
        thinking = typeof value === "function" ? value(thinking) : value;
      },
      setStreamingToolCalls: (value) => {
        toolCalls = typeof value === "function" ? value(toolCalls) : value;
      },
      cancelStreamingFlushesRef,
      onDone,
      onError: vi.fn(),
    });

    handlers.onText("world");
    handlers.onText("!");
    handlers.onThinking(" more");
    handlers.onToolStart({ toolName: "write", args: { path: "a.ts" } });
    handlers.onToolEnd({ toolName: "write", isError: false, result: "done" });

    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();

    expect(text).toBe("Hello world!");
    expect(thinking).toBe("thinking… more");
    expect(toolCalls).toEqual([
      { toolName: "read", status: "completed", isError: false, result: "seeded" },
      { toolName: "write", args: { path: "a.ts" }, status: "completed", isError: false, result: "done" },
    ]);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith({
      messageId: "m-1",
      message: undefined,
      accumulated: {
        text: "Hello world!",
        thinking: "thinking… more",
        toolCalls,
        fallbackInfo: undefined,
      },
    });

    vi.useRealTimers();
  });

  /*
  FNXC:AssistantTextCapture 2026-09-15-22:45:
  FN-431: a reconnect resumes from the persisted checkpoint and then replays only the events after
  its cursor. The opening words live in the checkpoint, so replaying them again would recreate the
  reported "I'll researchI'll research" duplication on the client side.
  */
  it("FN-431 resumes from a checkpoint without repeating its opening words", () => {
    vi.useFakeTimers();

    const prefix = "I'll research";
    const suffix = " the codebase before writing the spec.";
    let text = prefix;
    const onDone = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      initialText: prefix,
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone,
      onError: vi.fn(),
    });

    // Only the events strictly after the checkpoint cursor are replayed.
    handlers.onText(suffix);
    vi.advanceTimersToNextTimer();

    expect(text).toBe(prefix + suffix);
    expect(text).not.toBe(prefix + prefix + suffix);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      accumulated: expect.objectContaining({ text: prefix + suffix }),
    }));

    vi.useRealTimers();
  });

  it("FN-431 keeps two legitimately identical fragments", () => {
    vi.useFakeTimers();

    const prefix = "I'll research";
    let text = "";
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    handlers.onText(prefix);
    handlers.onText(prefix);
    vi.advanceTimersToNextTimer();

    expect(text).toBe(prefix + prefix);

    vi.useRealTimers();
  });

  /*
  FNXC:ChatMessageEdit 2026-09-16-05:58:
  FN-459. The factory must join the stream's own `tempUserMessageId` onto the in-band identity event
  so the caller reconciles its optimistic bubble by EXACT temp id rather than by content equality
  (two identical consecutive sends would otherwise collide and leave a `temp-<ts>` id behind).
  */
  it("joins the stream's tempUserMessageId onto the in-band user_message event", () => {
    const onUserMessage = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1789537275231",
      setStreamingText: vi.fn(),
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onUserMessage,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    const persisted = {
      id: "msg-ab12cd34",
      sessionId: "s-1",
      role: "user" as const,
      content: "bonjour",
      thinkingOutput: null,
      metadata: null,
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    handlers.onUserMessage?.({ message: persisted });

    expect(onUserMessage).toHaveBeenCalledTimes(1);
    expect(onUserMessage).toHaveBeenCalledWith({
      message: persisted,
      tempUserMessageId: "temp-1789537275231",
    });
  });

  it("omits onUserMessage entirely when the caller does not opt in", () => {
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };
    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1",
      setStreamingText: vi.fn(),
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    expect(handlers.onUserMessage).toBeUndefined();
  });
});
