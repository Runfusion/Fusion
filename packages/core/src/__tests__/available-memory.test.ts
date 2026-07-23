import { afterEach, describe, expect, it, vi } from "vitest";

const { freememMock } = vi.hoisted(() => ({
  freememMock: vi.fn(),
}));

vi.mock("node:os", () => ({
  freemem: freememMock,
}));

import { getAvailableMemoryBytes, getAvailableMemoryInfo } from "../process/available-memory.js";

type ProcessWithAvailableMemory = NodeJS.Process & { availableMemory?: () => number };

function restoreAvailableMemory(original: ProcessWithAvailableMemory["availableMemory"]): void {
  const proc = process as ProcessWithAvailableMemory;
  if (original) {
    proc.availableMemory = original;
  } else {
    Reflect.deleteProperty(proc, "availableMemory");
  }
}

describe("getAvailableMemoryInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    freememMock.mockReset();
  });

  it("reports a reliable reading from process.availableMemory when present", () => {
    const proc = process as ProcessWithAvailableMemory;
    const original = proc.availableMemory;
    proc.availableMemory = vi.fn(() => 123_456_789);
    try {
      expect(getAvailableMemoryInfo()).toEqual({ bytes: 123_456_789, reliable: true });
      expect(getAvailableMemoryBytes()).toBe(123_456_789);
      expect(proc.availableMemory).toHaveBeenCalledTimes(2);
      expect(freememMock).not.toHaveBeenCalled();
    } finally {
      restoreAvailableMemory(original);
    }
  });

  it("falls back to os.freemem and flags the reading unreliable when the API is missing", () => {
    const proc = process as ProcessWithAvailableMemory;
    const original = proc.availableMemory;
    Reflect.deleteProperty(proc, "availableMemory");
    freememMock.mockReturnValue(42);
    try {
      expect(getAvailableMemoryInfo()).toEqual({ bytes: 42, reliable: false });
    } finally {
      restoreAvailableMemory(original);
    }
  });

  it("falls back unreliable when process.availableMemory throws", () => {
    const proc = process as ProcessWithAvailableMemory;
    const original = proc.availableMemory;
    proc.availableMemory = vi.fn(() => {
      throw new Error("not supported");
    });
    freememMock.mockReturnValue(7);
    try {
      expect(getAvailableMemoryInfo()).toEqual({ bytes: 7, reliable: false });
    } finally {
      restoreAvailableMemory(original);
    }
  });

  it("treats zero, NaN, and negative availableMemory readings as unavailable", () => {
    const proc = process as ProcessWithAvailableMemory;
    const original = proc.availableMemory;
    freememMock.mockReturnValue(64);
    try {
      for (const invalid of [0, Number.NaN, -1]) {
        proc.availableMemory = vi.fn(() => invalid);
        expect(getAvailableMemoryInfo()).toEqual({ bytes: 64, reliable: false });
      }
    } finally {
      restoreAvailableMemory(original);
    }
  });
});
