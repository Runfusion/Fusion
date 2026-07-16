import { describe, expect, it } from "vitest";
import { formatBytes } from "../formatBytes";

describe("formatBytes", () => {
  it("formats byte-unit boundaries with granular local sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
  });

  it("marks negative and non-finite measurements unavailable", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
