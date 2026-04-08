import type { Response } from "express";

export interface SessionBufferedEvent {
  id: number;
  event: string;
  data: string;
}

/**
 * Per-session in-memory ring buffer for SSE events.
 *
 * Stores only the last N events and assigns monotonically increasing IDs.
 */
export class SessionEventBuffer {
  private events: SessionBufferedEvent[] = [];
  private nextId = 1;

  constructor(private readonly maxCapacity = 100) {
    if (!Number.isFinite(maxCapacity) || maxCapacity <= 0) {
      throw new Error("maxCapacity must be a positive finite number");
    }
  }

  /**
   * Push an event into the buffer and return the assigned event id.
   */
  push(event: string, data: string): number {
    const id = this.nextId++;
    this.events.push({ id, event, data });

    if (this.events.length > this.maxCapacity) {
      this.events.splice(0, this.events.length - this.maxCapacity);
    }

    return id;
  }

  /**
   * Return all buffered events with id > lastEventId.
   */
  getEventsSince(lastEventId: number): SessionBufferedEvent[] {
    if (!Number.isFinite(lastEventId)) {
      return [...this.events];
    }

    return this.events.filter((event) => event.id > lastEventId);
  }

  clear(): void {
    this.events = [];
  }

  size(): number {
    return this.events.length;
  }
}

/**
 * Render one SSE event payload (with optional id field).
 */
export function formatSSEEvent(event: string, data: string, id?: number): string {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Safely write to an SSE response stream.
 */
export function safeWriteSSE(res: Pick<Response, "write" | "writableEnded" | "destroyed">, payload: string): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one SSE event to response with optional id field.
 */
export function writeSSEEvent(
  res: Pick<Response, "write" | "writableEnded" | "destroyed">,
  event: string,
  data: string,
  id?: number,
): boolean {
  return safeWriteSSE(res, formatSSEEvent(event, data, id));
}
