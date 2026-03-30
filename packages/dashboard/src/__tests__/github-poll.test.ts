import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubRateLimiter } from "../github-poll.js";

describe("GitHubRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows requests within the rate limit", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 3, windowMs: 60000 });

    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
  });

  it("denies requests when rate limit is exceeded", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.canMakeRequest("owner/repo");
    limiter.canMakeRequest("owner/repo");
    
    expect(limiter.canMakeRequest("owner/repo")).toBe(false);
  });

  it("resets rate limit after window expires", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.canMakeRequest("owner/repo");
    limiter.canMakeRequest("owner/repo");
    expect(limiter.canMakeRequest("owner/repo")).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(61000);

    expect(limiter.canMakeRequest("owner/repo")).toBe(true);
  });

  it("tracks different repositories independently", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    limiter.canMakeRequest("owner/repo1");
    limiter.canMakeRequest("owner/repo1");
    
    // repo1 is at limit
    expect(limiter.canMakeRequest("owner/repo1")).toBe(false);
    
    // repo2 is not affected
    expect(limiter.canMakeRequest("owner/repo2")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo2")).toBe(true);
    expect(limiter.canMakeRequest("owner/repo2")).toBe(false);
  });

  it("returns null reset time when no requests have been made", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    expect(limiter.getResetTime("owner/repo")).toBeNull();
  });

  it("returns correct reset time after requests", () => {
    const limiter = new GitHubRateLimiter({ maxRequests: 2, windowMs: 60000 });

    const before = Date.now();
    limiter.canMakeRequest("owner/repo");
    
    const resetTime = limiter.getResetTime("owner/repo");
    expect(resetTime).not.toBeNull();
    expect(resetTime!.getTime()).toBeGreaterThan(before);
    expect(resetTime!.getTime()).toBeLessThanOrEqual(before + 60000);
  });

  it("uses default values when not specified", () => {
    const limiter = new GitHubRateLimiter();
    
    // Default is 90 requests per hour
    for (let i = 0; i < 90; i++) {
      expect(limiter.canMakeRequest("owner/repo")).toBe(true);
    }
    expect(limiter.canMakeRequest("owner/repo")).toBe(false);
  });
});
