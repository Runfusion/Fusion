/*
FNXC:GhAsyncChecks 2026-10-18-01:20:
The default PR-monitor gh client must use only the async gh helpers. The sync ones block the
daemon event loop for each 30 s comment poll.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";

const core = vi.hoisted(() => ({
  isGhAvailable: vi.fn(() => { throw new Error("sync isGhAvailable must not be used"); }),
  isGhAuthenticated: vi.fn(() => { throw new Error("sync isGhAuthenticated must not be used"); }),
  runGhJson: vi.fn(() => { throw new Error("sync runGhJson must not be used"); }),
  isGhAvailableAsync: vi.fn(async () => true),
  isGhAuthenticatedAsync: vi.fn(async () => true),
  runGhJsonAsync: vi.fn(async () => ({
    comments: [
      { id: "1", body: "old", author: { login: "a" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", url: "u1" },
      { id: "2", body: "new", author: { login: "b" }, createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", url: "u2" },
    ],
  })),
}));

vi.mock("@fusion/core", () => core);

import { createDefaultPrMonitorGhClient } from "../merge/pr-monitor-gh.js";

describe("default PR monitor gh client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks gh availability and auth through the async helpers", async () => {
    await expect(createDefaultPrMonitorGhClient().checkAuth()).resolves.toBe(true);
    expect(core.isGhAvailableAsync).toHaveBeenCalledTimes(1);
    expect(core.isGhAuthenticatedAsync).toHaveBeenCalledTimes(1);
    expect(core.isGhAvailable).not.toHaveBeenCalled();
    expect(core.isGhAuthenticated).not.toHaveBeenCalled();
  });

  it("reports unauthenticated when the async check says so", async () => {
    core.isGhAuthenticatedAsync.mockResolvedValueOnce(false);
    await expect(createDefaultPrMonitorGhClient().checkAuth()).resolves.toBe(false);
  });

  it("fetches comments through runGhJsonAsync and keeps the since filter", async () => {
    const comments = await createDefaultPrMonitorGhClient().fetchComments({ owner: "o", repo: "r", prNumber: 7, since: "2026-01-02T00:00:00Z" });
    expect(core.runGhJsonAsync).toHaveBeenCalledWith(["pr", "view", "7", "--repo", "o/r", "--json", "comments"]);
    expect(core.runGhJson).not.toHaveBeenCalled();
    expect(comments.map((c) => c.id)).toEqual([2]);
    expect(comments[0]).toMatchObject({ body: "new", user: { login: "b" }, html_url: "u2" });
  });
});
