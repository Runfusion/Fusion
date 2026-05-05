import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatResponse } from "../legacy";

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
      expect(donePayloads).toEqual([{ messageId: "msg-1", message: { id: "msg-1", sessionId: "s-1", role: "assistant", content: "Final reply", thinkingOutput: null, metadata: null, createdAt: "2026-01-01T00:00:00.000Z" } }]);
    });
  });

  it("handles done events that have no data payload", async () => {    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
});
