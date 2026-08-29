import { describe, expect, it } from "vitest";
import { pickPreferredBadge } from "../TaskCardBadge";

describe("pickPreferredBadge", () => {
  const taskValue = { number: 1, lastCheckedAt: "2026-05-13T10:00:00.000Z" };
  const liveValue = { number: 2, lastCheckedAt: "2026-05-13T11:00:00.000Z" };

  it("returns undefined when both values are missing", () => {
    expect(pickPreferredBadge(undefined, undefined, undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when live is null and task is missing", () => {
    expect(pickPreferredBadge(null, "2026-05-13T12:00:00.000Z", undefined, undefined)).toBeUndefined();
  });

  it("keeps task value when live is null", () => {
    expect(
      pickPreferredBadge(null, "2026-05-13T12:00:00.000Z", taskValue, "2026-05-13T10:00:00.000Z"),
    ).toEqual(taskValue);
  });

  it("prefers live when newer", () => {
    expect(
      pickPreferredBadge(liveValue, "2026-05-13T12:00:00.000Z", taskValue, "2026-05-13T10:00:00.000Z"),
    ).toEqual(liveValue);
  });

  it("prefers task when newer", () => {
    expect(
      pickPreferredBadge(liveValue, "2026-05-13T10:00:00.000Z", taskValue, "2026-05-13T12:00:00.000Z"),
    ).toEqual(taskValue);
  });
});
