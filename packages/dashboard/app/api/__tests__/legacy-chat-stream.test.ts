import { afterEach, describe, expect, it, vi } from "vitest";
import { attachChatStream, streamChatResponse } from "../legacy";

function createChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("streamChatResponse SSE parser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reconstructs text/done events split across arbitrary chunks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        createChunkedStream([
          "event: text\n",
          "data: \"Hel",
          "lo \"\n\n",
          "event: text\n",
          "data: \"world\"\n\n",
          "event: done\n",
          "data: {\"messageId\":\"msg-1\"}\n\n",
        ]),
        { status: 200 },
      ),
    );

    const textChunks: string[] = [];
    const donePayloads: Array<{ messageId: string; message?: { content: string } }> = [];

    streamChatResponse("s-1", "hi", {
      onText: (data) => textChunks.push(data),
      onDone: (data) => donePayloads.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(textChunks.join("")).toBe("Hello world");
      expect(donePayloads).toEqual([{ messageId: "msg-1" }]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires acceptance once before the first stream event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(createChunkedStream(["event: text\ndata: \"Hello\"\n\nevent: done\ndata: {\"messageId\":\"msg-1\"}\n\n"]), { status: 200 }),
    );

    const events: string[] = [];
    streamChatResponse("s-1", "hi", {
      onAccepted: () => events.push("accepted"),
      onText: () => events.push("text"),
      onDone: () => events.push("done"),
    });

    await vi.waitFor(() => expect(events).toEqual(["accepted", "text", "done"]));
  });

  it.each([
    { name: "the response is rejected", result: new Response("no", { status: 500 }) },
    { name: "fetch rejects", result: new Error("network failure") },
  ])("does not accept when $name", async ({ result }) => {
    const onAccepted = vi.fn();
    const onError = vi.fn();
    if (result instanceof Error) {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(result);
    } else {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(result);
    }

    streamChatResponse("s-1", "hi", { onAccepted, onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ requestAccepted: false });
  });

  it("flushes terminal done event when stream ends without final newline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(createChunkedStream(["event: done\ndata: {\"messageId\":\"msg-tail\"}"]), { status: 200 }),
    );

    const donePayloads: Array<{ messageId: string }> = [];

    streamChatResponse("s-1", "hi", {
      onDone: (data) => donePayloads.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(donePayloads).toEqual([{ messageId: "msg-tail" }]);
    });
  });

  it("parses done payload assistant snapshots when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        createChunkedStream([
          "event: done\n",
          "data: {\"messageId\":\"msg-1\",\"message\":{\"id\":\"msg-1\",\"sessionId\":\"s-1\",\"role\":\"assistant\",\"content\":\"Final reply\",\"thinkingOutput\":null,\"metadata\":null,\"createdAt\":\"2026-01-01T00:00:00.000Z\"}}\n\n",
        ]),
        { status: 200 },
      ),
    );

    const donePayloads: Array<{ messageId: string; message?: { content: string } }> = [];

    streamChatResponse("s-1", "hi", {
      onDone: (data) => donePayloads.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(donePayloads).toEqual([
        {
          messageId: "msg-1",
          message: {
            id: "msg-1",
            sessionId: "s-1",
            role: "assistant",
            content: "Final reply",
            thinkingOutput: null,
            metadata: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]);
    });
  });

  it("handles done events that have no data payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(createChunkedStream(["event: done\n\n"]), { status: 200 }),
    );

    const donePayloads: Array<{ messageId: string }> = [];

    streamChatResponse("s-1", "hi", {
      onDone: (data) => donePayloads.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(donePayloads).toEqual([{ messageId: "" }]);
    });
  });

  it("keeps accepted streams open when no real stream events arrive before timeout", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
    }), { status: 200 }));

    const onError = vi.fn();
    const textChunks: string[] = [];
    const donePayloads: Array<{ messageId: string }> = [];
    streamChatResponse("s-1", "hi", {
      onText: (data) => textChunks.push(data),
      onDone: (data) => donePayloads.push(data),
      onError,
    }, undefined, undefined, { firstEventTimeoutMs: 1_000 });

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(onError).not.toHaveBeenCalled();

    streamController?.enqueue(encoder.encode("event: text\ndata: \"Late reply\"\n\n"));
    streamController?.enqueue(encoder.encode("event: done\ndata: {\"messageId\":\"msg-late\"}\n\n"));
    streamController?.close();

    await vi.waitFor(() => {
      expect(textChunks).toEqual(["Late reply"]);
      expect(donePayloads).toEqual([{ messageId: "msg-late" }]);
    });
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "leading-space second delta",
      chunks: [
        "event: text\n",
        "data: \"Hello.\"\n\n",
        "event: text\n",
        "data: \" World.\"\n\n",
      ],
    },
    {
      name: "space-trailing first delta",
      chunks: [
        "event: text\n",
        "data: \"Hello. \"\n\n",
        "event: text\n",
        "data: \"World.\"\n\n",
      ],
    },
    {
      name: "empty delta between spaced chunks",
      chunks: [
        "event: text\n",
        "data: \"Hello.\"\n\n",
        "event: text\n",
        "data: \"\"\n\n",
        "event: text\n",
        "data: \" World.\"\n\n",
      ],
    },
    {
      name: "chunk boundary mid-json of second delta",
      chunks: [
        "event: text\ndata: \"Hello.\"\n\nevent: text\ndata: \"",
        " World.\"\n\n",
      ],
    },
    {
      name: "chunk boundary inside leading space on data line",
      chunks: [
        "event: text\ndata: \"Hello.\"\n\nevent: text\ndata: \" ",
        "World.\"\n\n",
      ],
    },
  ])("preserves whitespace at SSE delta boundaries: $name", async ({ chunks }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(createChunkedStream(chunks), { status: 200 }));

    const textChunks: string[] = [];

    streamChatResponse("s-1", "hi", {
      onText: (data) => textChunks.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(textChunks.join("")).toBe("Hello. World.");
    });
  });
});

describe("attachChatStream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays buffered events and done", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        createChunkedStream([
          "event: text\n",
          "data: \"Hello\"\n\n",
          "event: done\n",
          "data: {\"messageId\":\"m-1\"}\n\n",
        ]),
        { status: 200 },
      ),
    );

    const textChunks: string[] = [];
    const donePayloads: Array<{ messageId: string }> = [];

    attachChatStream("s-1", {
      onText: (data) => textChunks.push(data),
      onDone: (data) => donePayloads.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(textChunks).toEqual(["Hello"]);
      expect(donePayloads).toEqual([{ messageId: "m-1" }]);
    });
  });

  it("delivers live events after replay", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        createChunkedStream([
          "event: text\n",
          "data: \"A\"\n\n",
          "event: text\n",
          "data: \"B\"\n\n",
        ]),
        { status: 200 },
      ),
    );

    const textChunks: string[] = [];

    attachChatStream("s-1", {
      onText: (data) => textChunks.push(data),
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(textChunks).toEqual(["A", "B"]);
    });
  });

  it("aborts fetch when close is called", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {
        // keep open until aborted
      });
    });

    const stream = attachChatStream("s-1", { onError: vi.fn() });
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });

    stream.close();
    expect(signal?.aborted).toBe(true);
    expect(stream.isConnected()).toBe(false);
  });
});
