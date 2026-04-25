import { describe, it, expect, beforeEach } from "vitest";
import { LogRingBuffer } from "../log-ring-buffer.js";

describe("LogRingBuffer", () => {
  let buffer: LogRingBuffer;

  beforeEach(() => {
    buffer = new LogRingBuffer();
  });

  it("stores entries and reports total count", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "test1" });
    buffer.push({ timestamp: new Date(), level: "warn", message: "test2" });
    expect(buffer.total).toBe(2);
  });

  it("returns all entries in chronological order", () => {
    buffer.push({ timestamp: new Date("2026-01-01T10:00:00"), level: "info", message: "first" });
    buffer.push({ timestamp: new Date("2026-01-01T11:00:00"), level: "info", message: "second" });
    const entries = buffer.getAll();
    expect(entries.length).toBe(2);
    expect(entries[0].message).toBe("first");
    expect(entries[1].message).toBe("second");
  });

  it("caps at MAX_LOG_ENTRIES (1000)", () => {
    for (let i = 0; i < 1500; i++) {
      buffer.push({ timestamp: new Date(), level: "info", message: `entry-${i}` });
    }
    const entries = buffer.getAll();
    expect(entries.length).toBe(1000);
    expect(buffer.total).toBe(1500);
  });

  it("maintains chronological order when overwriting", () => {
    for (let i = 0; i < 1500; i++) {
      buffer.push({ timestamp: new Date(2026, 0, 1, 0, i), level: "info", message: `entry-${i}` });
    }
    const entries = buffer.getAll();
    expect(entries.length).toBe(1000);
    expect(entries[0].message).toBe("entry-500");
    expect(entries[entries.length - 1].message).toBe("entry-1499");
  });

  it("clears all entries", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "test" });
    buffer.clear();
    expect(buffer.getAll().length).toBe(0);
    expect(buffer.total).toBe(0);
  });

  it("stores entries with different levels", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "info msg" });
    buffer.push({ timestamp: new Date(), level: "warn", message: "warn msg" });
    buffer.push({ timestamp: new Date(), level: "error", message: "error msg" });
    const entries = buffer.getAll();
    expect(entries[0].level).toBe("info");
    expect(entries[1].level).toBe("warn");
    expect(entries[2].level).toBe("error");
  });

  it("stores entries with prefix", () => {
    buffer.push({ timestamp: new Date(), level: "info", message: "msg", prefix: "engine" });
    const entries = buffer.getAll();
    expect(entries[0].prefix).toBe("engine");
  });
});
