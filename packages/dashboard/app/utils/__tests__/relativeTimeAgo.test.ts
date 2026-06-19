import { describe, expect, it } from "vitest";
import { formatRelativeTimeAgo, getRelativeTimeBucket } from "../relativeTimeAgo";

describe("formatRelativeTimeAgo", () => {
  const now = Date.parse("2026-06-17T15:40:00.000Z");

  it("formats timestamps under one minute as just now", () => {
    expect(formatRelativeTimeAgo("2026-06-17T15:39:30.000Z", now)).toBe("just now");
  });

  it("formats timestamps under one hour as minutes ago", () => {
    expect(formatRelativeTimeAgo("2026-06-17T15:35:00.000Z", now)).toBe("5m ago");
  });

  it("formats timestamps under one day as hours ago", () => {
    expect(formatRelativeTimeAgo("2026-06-17T13:40:00.000Z", now)).toBe("2h ago");
  });

  it("formats timestamps under seven days as days ago", () => {
    expect(formatRelativeTimeAgo("2026-06-14T15:40:00.000Z", now)).toBe("3d ago");
  });

  it("falls back to a locale date string for older timestamps", () => {
    const iso = "2026-06-01T15:40:00.000Z";
    expect(formatRelativeTimeAgo(iso, now)).toBe(new Date(iso).toLocaleDateString());
  });

  it("returns an empty string for invalid or empty timestamps", () => {
    expect(formatRelativeTimeAgo("", now)).toBe("");
    expect(formatRelativeTimeAgo("not-a-date", now)).toBe("");
  });

  it("preserves future timestamp output as just now", () => {
    expect(formatRelativeTimeAgo("2026-06-17T15:40:01.000Z", now)).toBe("just now");
  });
});

describe("getRelativeTimeBucket", () => {
  const now = Date.parse("2026-06-17T15:40:00.000Z");

  it("returns null for empty, unparseable, and future timestamps", () => {
    expect(getRelativeTimeBucket("", now)).toBeNull();
    expect(getRelativeTimeBucket("not-a-date", now)).toBeNull();
    expect(getRelativeTimeBucket("2026-06-17T15:40:01.000Z", now)).toBeNull();
  });

  it("buckets timestamps under one minute as just-now", () => {
    expect(getRelativeTimeBucket("2026-06-17T15:39:01.000Z", now)).toMatchObject({
      bucket: "just-now",
      count: 0,
      days: 0,
    });
  });

  it("buckets the exact one-minute boundary as minutes", () => {
    expect(getRelativeTimeBucket("2026-06-17T15:39:00.000Z", now)).toMatchObject({
      bucket: "minutes",
      count: 1,
      days: 0,
    });
  });

  it("buckets the exact one-hour boundary as hours", () => {
    expect(getRelativeTimeBucket("2026-06-17T14:40:00.000Z", now)).toMatchObject({
      bucket: "hours",
      count: 1,
      days: 0,
    });
  });

  it("buckets the exact one-day boundary as days", () => {
    expect(getRelativeTimeBucket("2026-06-16T15:40:00.000Z", now)).toMatchObject({
      bucket: "days",
      count: 1,
      days: 1,
    });
  });

  it("buckets the exact seven-day boundary as weeks with total days", () => {
    expect(getRelativeTimeBucket("2026-06-10T15:40:00.000Z", now)).toMatchObject({
      bucket: "weeks",
      count: 1,
      days: 7,
    });
  });

  it("buckets timestamps just under four weeks as weeks with total days", () => {
    expect(getRelativeTimeBucket("2026-05-20T15:40:01.000Z", now)).toMatchObject({
      bucket: "weeks",
      count: 3,
      days: 27,
    });
  });

  it("buckets the exact four-week boundary as older with total days", () => {
    expect(getRelativeTimeBucket("2026-05-20T15:40:00.000Z", now)).toMatchObject({
      bucket: "older",
      count: 4,
      days: 28,
    });
  });

  it("returns the parsed date for locale fallback callers", () => {
    const iso = "2026-06-01T15:40:00.000Z";
    expect(getRelativeTimeBucket(iso, now)?.date.toISOString()).toBe(iso);
  });
});
