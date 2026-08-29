import { describe, expect, it } from "vitest";
import { SessionEventBuffer } from "../sse-buffer.js";

describe("SessionEventBuffer", () => {
  it("push assigns monotonically increasing ids", () => {
    const buffer = new SessionEventBuffer(10);

    const id1 = buffer.push("thinking", JSON.stringify("a"));
    const id2 = buffer.push("question", JSON.stringify({ id: "q-1" }));

    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it("getEventsSince returns only events newer than lastEventId", () => {
    const buffer = new SessionEventBuffer(10);

    buffer.push("thinking", JSON.stringify("a"));
    buffer.push("thinking", JSON.stringify("b"));
    buffer.push("question", JSON.stringify({ id: "q-1" }));

    const events = buffer.getEventsSince(1);
    expect(events.map((event) => event.id)).toEqual([2, 3]);
  });

  it("drops oldest events when capacity overflows", () => {
    const buffer = new SessionEventBuffer(2);

    buffer.push("thinking", JSON.stringify("a"));
    buffer.push("thinking", JSON.stringify("b"));
    buffer.push("question", JSON.stringify({ id: "q-1" }));

    const events = buffer.getEventsSince(0);
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe(2);
    expect(events[1]?.id).toBe(3);
  });

  it("returns empty array for an empty buffer", () => {
    const buffer = new SessionEventBuffer(10);
    expect(buffer.getEventsSince(0)).toEqual([]);
  });

  it("returns all buffered events for non-finite lastEventId", () => {
    const buffer = new SessionEventBuffer(10);
    buffer.push("thinking", JSON.stringify("a"));
    buffer.push("complete", JSON.stringify({}));

    expect(buffer.getEventsSince(Number.NaN)).toHaveLength(2);
  });

  it("supports interleaved push/read access without duplicate ids", async () => {
    const buffer = new SessionEventBuffer(20);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        Promise.resolve().then(() => {
          const eventId = buffer.push("thinking", JSON.stringify(`event-${index + 1}`));
          const snapshot = buffer.getEventsSince(Math.max(0, eventId - 1));
          expect(snapshot[snapshot.length - 1]?.id).toBe(eventId);
        }),
      ),
    );

    const events = buffer.getEventsSince(0);
    expect(events).toHaveLength(10);
    expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
