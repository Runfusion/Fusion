import { describe, expect, it } from "vitest";
import { formatPreciseClockTime, formatPreciseTimestampFull } from "../preciseTimestamp";

const localIso = (year: number, month: number, day: number, hours: number, minutes: number, seconds: number, milliseconds: number): string => (
  new Date(year, month - 1, day, hours, minutes, seconds, milliseconds).toISOString()
);

const now = new Date(2026, 5, 17, 16, 40, 0, 0).getTime();

describe("formatPreciseClockTime", () => {
  it("formats same-local-day timestamps as a precise 24-hour clock", () => {
    expect(formatPreciseClockTime(localIso(2026, 6, 17, 14, 32, 7, 482), now)).toBe("14:32:07.482");
  });

  it("prefixes timestamps from a different local calendar day with their date", () => {
    expect(formatPreciseClockTime(localIso(2026, 6, 16, 14, 32, 7, 482), now)).toBe("2026-06-16 14:32:07.482");
  });

  it("zero-pads milliseconds, clock units, and midnight", () => {
    expect(formatPreciseClockTime(localIso(2026, 6, 17, 0, 0, 0, 0), now)).toBe("00:00:00.000");
    expect(formatPreciseClockTime(localIso(2026, 6, 17, 1, 2, 3, 7), now)).toBe("01:02:03.007");
    expect(formatPreciseClockTime(localIso(2026, 6, 17, 1, 2, 3, 70), now)).toBe("01:02:03.070");
    expect(formatPreciseClockTime(localIso(2026, 6, 17, 1, 2, 3, 482), now)).toBe("01:02:03.482");
  });

  it("preserves future timestamps as their real wall-clock reading", () => {
    expect(formatPreciseClockTime(localIso(2026, 6, 17, 18, 0, 0, 501), now)).toBe("18:00:00.501");
  });

  it("returns an empty string for missing or invalid input", () => {
    expect(formatPreciseClockTime(undefined, now)).toBe("");
    expect(formatPreciseClockTime("", now)).toBe("");
    expect(formatPreciseClockTime("not-a-date", now)).toBe("");
  });
});

describe("formatPreciseTimestampFull", () => {
  it("always includes the local date and precise clock", () => {
    expect(formatPreciseTimestampFull(localIso(2026, 6, 17, 14, 32, 7, 482))).toBe("2026-06-17 14:32:07.482");
  });

  it("returns an empty string for missing or invalid input", () => {
    expect(formatPreciseTimestampFull(undefined)).toBe("");
    expect(formatPreciseTimestampFull("not-a-date")).toBe("");
  });
});
