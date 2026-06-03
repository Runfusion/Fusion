import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { getAvailableMemoryInfo } from "../controller.js";

type ProcessWithAvailableMemory = NodeJS.Process & { availableMemory?: () => number };

describe("getAvailableMemoryInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a reliable reading from process.availableMemory when present", () => {
    const proc = process as ProcessWithAvailableMemory;
    if (typeof proc.availableMemory !== "function") {
      // Older runtime without the API — covered by the fallback test below.
      return;
    }
    const spy = vi.spyOn(proc, "availableMemory").mockReturnValue(123_456_789);

    expect(getAvailableMemoryInfo()).toEqual({ bytes: 123_456_789, reliable: true });
    expect(spy).toHaveBeenCalled();
  });

  it("falls back to os.freemem and flags the reading unreliable when the API is missing", () => {
    const proc = process as ProcessWithAvailableMemory;
    const original = proc.availableMemory;
    // Simulate a runtime without process.availableMemory (Node < 22). The
    // freemem fallback must be flagged unreliable: on macOS freemem reads
    // ~99% used on an idle machine, and treating it as a pressure signal made
    // the vitest auto-kill fire every 30s (2026-06-03 incident).
    Reflect.deleteProperty(proc, "availableMemory");
    const freememSpy = vi.spyOn(os, "freemem").mockReturnValue(42);
    try {
      expect(getAvailableMemoryInfo()).toEqual({ bytes: 42, reliable: false });
    } finally {
      if (original) proc.availableMemory = original;
      freememSpy.mockRestore();
    }
  });

  it("falls back unreliable when process.availableMemory throws", () => {
    const proc = process as ProcessWithAvailableMemory;
    if (typeof proc.availableMemory !== "function") return;
    vi.spyOn(proc, "availableMemory").mockImplementation(() => {
      throw new Error("not supported");
    });
    const freememSpy = vi.spyOn(os, "freemem").mockReturnValue(7);
    try {
      expect(getAvailableMemoryInfo()).toEqual({ bytes: 7, reliable: false });
    } finally {
      freememSpy.mockRestore();
    }
  });
});
