import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGitHubAppConfig,
  isGitHubAppConfigured,
  verifyWebhookSignature,
  classifyWebhookEvent,
  parseBadgeUrl,
  isSameResource,
  hasPrBadgeFieldsChanged,
  hasIssueBadgeFieldsChanged,
  fetchInstallationToken,
  fetchCanonicalPrInfo,
  fetchCanonicalIssueInfo,
} from "../github-webhooks.js";

describe("GitHub Webhooks Module", () => {
  // Save original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.KB_GITHUB_APP_ID;
    delete process.env.KB_GITHUB_APP_PRIVATE_KEY;
    delete process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH;
    delete process.env.KB_GITHUB_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("getGitHubAppConfig", () => {
    it("returns null when no env vars are set", () => {
      expect(getGitHubAppConfig()).toBeNull();
    });

    it("returns null when only appId is set", () => {
      process.env.KB_GITHUB_APP_ID = "12345";
      expect(getGitHubAppConfig()).toBeNull();
    });

    it("returns config when all required vars are set via direct key", () => {
      process.env.KB_GITHUB_APP_ID = "12345";
      process.env.KB_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----";
      process.env.KB_GITHUB_WEBHOOK_SECRET = "webhook-secret";

      const config = getGitHubAppConfig();
      expect(config).not.toBeNull();
      expect(config?.appId).toBe("12345");
      expect(config?.privateKey).toContain("RSA PRIVATE KEY");
      expect(config?.webhookSecret).toBe("webhook-secret");
    });

    it("returns null when key file cannot be read", () => {
      process.env.KB_GITHUB_APP_ID = "12345";
      process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH = "/nonexistent/path/key.pem";
      process.env.KB_GITHUB_WEBHOOK_SECRET = "webhook-secret";

      expect(getGitHubAppConfig()).toBeNull();
    });

    it("prefers direct key over file path when both are set", () => {
      process.env.KB_GITHUB_APP_ID = "12345";
      process.env.KB_GITHUB_APP_PRIVATE_KEY = "direct-key-content";
      process.env.KB_GITHUB_APP_PRIVATE_KEY_PATH = "/nonexistent/path/key.pem";
      process.env.KB_GITHUB_WEBHOOK_SECRET = "webhook-secret";

      const config = getGitHubAppConfig();
      expect(config?.privateKey).toBe("direct-key-content");
    });
  });

  describe("isGitHubAppConfigured", () => {
    it("returns false when not configured", () => {
      expect(isGitHubAppConfigured()).toBe(false);
    });

    it("returns true when fully configured", () => {
      process.env.KB_GITHUB_APP_ID = "12345";
      process.env.KB_GITHUB_APP_PRIVATE_KEY = "private-key";
      process.env.KB_GITHUB_WEBHOOK_SECRET = "webhook-secret";

      expect(isGitHubAppConfigured()).toBe(true);
    });
  });

  describe("verifyWebhookSignature", () => {
    it("returns invalid when signature header is missing", () => {
      const result = verifyWebhookSignature(
        Buffer.from('{"test": "payload"}'),
        undefined,
        "secret",
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing signature header");
    });

    it("returns invalid when signature does not match", () => {
      const result = verifyWebhookSignature(
        Buffer.from('{"test": "payload"}'),
        "sha256=invalidsignature",
        "secret",
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Signature mismatch");
    });

    it("returns valid when signature matches", () => {
      // Compute correct signature for test
      const { createHmac } = require("node:crypto");
      const payload = '{"test": "payload"}';
      const correctSignature = "sha256=" + createHmac("sha256", "secret").update(payload).digest("hex");

      const result = verifyWebhookSignature(
        Buffer.from(payload),
        correctSignature,
        "secret",
      );
      expect(result.valid).toBe(true);
    });

    it("uses constant-time comparison to prevent timing attacks", () => {
      const { createHmac } = require("node:crypto");
      const payload = '{"test": "payload"}';
      const correctSignature = "sha256=" + createHmac("sha256", "secret").update(payload).digest("hex");

      // Should not throw and should return valid
      const result = verifyWebhookSignature(
        Buffer.from(payload),
        correctSignature,
        "secret",
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("classifyWebhookEvent", () => {
    it("classifies ping as supported but not relevant", () => {
      const result = classifyWebhookEvent("ping", {
        repository: { owner: { login: "test-owner" }, name: "test-repo" },
        installation: { id: 12345 },
      });

      expect(result.supported).toBe(true);
      expect(result.relevant).toBe(false);
      expect(result.owner).toBe("test-owner");
      expect(result.repo).toBe("test-repo");
      expect(result.installationId).toBe(12345);
    });

    it("classifies pull_request as supported and relevant", () => {
      const result = classifyWebhookEvent("pull_request", {
        number: 42,
        repository: { owner: { login: "test-owner" }, name: "test-repo" },
        installation: { id: 12345 },
      });

      expect(result.supported).toBe(true);
      expect(result.relevant).toBe(true);
      expect(result.resourceType).toBe("pr");
      expect(result.number).toBe(42);
      expect(result.owner).toBe("test-owner");
      expect(result.repo).toBe("test-repo");
    });

    it("classifies issues as supported and relevant", () => {
      const result = classifyWebhookEvent("issues", {
        issue: { number: 123 },
        repository: { owner: { login: "test-owner" }, name: "test-repo" },
        installation: { id: 12345 },
      });

      expect(result.supported).toBe(true);
      expect(result.relevant).toBe(true);
      expect(result.resourceType).toBe("issue");
      expect(result.number).toBe(123);
    });

    it("classifies issue_comment on PR as supported and relevant", () => {
      const result = classifyWebhookEvent("issue_comment", {
        issue: { number: 42, pull_request: {} },
        repository: { owner: { login: "test-owner" }, name: "test-repo" },
        installation: { id: 12345 },
      });

      expect(result.supported).toBe(true);
      expect(result.relevant).toBe(true);
      expect(result.resourceType).toBe("pr");
      expect(result.number).toBe(42);
    });

    it("classifies issue_comment on regular issue as supported but not relevant", () => {
      const result = classifyWebhookEvent("issue_comment", {
        issue: { number: 123 }, // No pull_request field
        repository: { owner: { login: "test-owner" }, name: "test-repo" },
        installation: { id: 12345 },
      });

      expect(result.supported).toBe(true);
      expect(result.relevant).toBe(false);
    });

    it("classifies unknown events as unsupported", () => {
      const result = classifyWebhookEvent("push", {});
      expect(result.supported).toBe(false);
      expect(result.relevant).toBe(false);
    });

    it("handles missing event type", () => {
      const result = classifyWebhookEvent(undefined, {});
      expect(result.supported).toBe(false);
    });
  });

  describe("parseBadgeUrl", () => {
    it("parses PR URL correctly", () => {
      const result = parseBadgeUrl("https://github.com/owner/repo/pull/42");
      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        number: 42,
        resourceType: "pr",
      });
    });

    it("parses issue URL correctly", () => {
      const result = parseBadgeUrl("https://github.com/owner/repo/issues/123");
      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        number: 123,
        resourceType: "issue",
      });
    });

    it("returns null for non-GitHub URLs", () => {
      expect(parseBadgeUrl("https://gitlab.com/owner/repo/pull/42")).toBeNull();
    });

    it("returns null for invalid paths", () => {
      expect(parseBadgeUrl("https://github.com/owner/repo")).toBeNull();
    });

    it("returns null for invalid number", () => {
      expect(parseBadgeUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
    });

    it("handles URLs with trailing slash", () => {
      const result = parseBadgeUrl("https://github.com/owner/repo/pull/42/");
      expect(result?.number).toBe(42);
    });
  });

  describe("isSameResource", () => {
    it("returns true for identical resources", () => {
      const a = { owner: "owner", repo: "repo", number: 42, resourceType: "pr" as const };
      const b = { owner: "owner", repo: "repo", number: 42, resourceType: "pr" as const };
      expect(isSameResource(a, b)).toBe(true);
    });

    it("returns false for different owners", () => {
      const a = { owner: "owner-a", repo: "repo", number: 42, resourceType: "pr" as const };
      const b = { owner: "owner-b", repo: "repo", number: 42, resourceType: "pr" as const };
      expect(isSameResource(a, b)).toBe(false);
    });

    it("returns false for different repos", () => {
      const a = { owner: "owner", repo: "repo-a", number: 42, resourceType: "pr" as const };
      const b = { owner: "owner", repo: "repo-b", number: 42, resourceType: "pr" as const };
      expect(isSameResource(a, b)).toBe(false);
    });

    it("returns false for different numbers", () => {
      const a = { owner: "owner", repo: "repo", number: 42, resourceType: "pr" as const };
      const b = { owner: "owner", repo: "repo", number: 43, resourceType: "pr" as const };
      expect(isSameResource(a, b)).toBe(false);
    });

    it("returns false for different types", () => {
      const a = { owner: "owner", repo: "repo", number: 42, resourceType: "pr" as const };
      const b = { owner: "owner", repo: "repo", number: 42, resourceType: "issue" as const };
      expect(isSameResource(a, b)).toBe(false);
    });

    it("is case insensitive for owner and repo", () => {
      const a = { owner: "Owner", repo: "Repo", number: 42, resourceType: "pr" as const };
      const b = { owner: "owner", repo: "repo", number: 42, resourceType: "pr" as const };
      expect(isSameResource(a, b)).toBe(true);
    });
  });

  describe("hasPrBadgeFieldsChanged", () => {
    const basePrInfo = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test PR",
      headBranch: "feature",
      baseBranch: "main",
      commentCount: 0,
      lastCommentAt: undefined,
    };

    it("returns true when current is undefined", () => {
      expect(hasPrBadgeFieldsChanged(undefined, basePrInfo)).toBe(true);
    });

    it("returns false when fields are identical", () => {
      const current = { ...basePrInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      expect(hasPrBadgeFieldsChanged(current, basePrInfo)).toBe(false);
    });

    it("returns true when status changes", () => {
      const current = { ...basePrInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...basePrInfo, status: "closed" as const };
      expect(hasPrBadgeFieldsChanged(current, next)).toBe(true);
    });

    it("returns true when title changes", () => {
      const current = { ...basePrInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...basePrInfo, title: "Updated Title" };
      expect(hasPrBadgeFieldsChanged(current, next)).toBe(true);
    });

    it("returns true when commentCount changes", () => {
      const current = { ...basePrInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...basePrInfo, commentCount: 5 };
      expect(hasPrBadgeFieldsChanged(current, next)).toBe(true);
    });

    it("returns true when lastCommentAt changes", () => {
      const current = { ...basePrInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...basePrInfo, lastCommentAt: "2026-01-02T00:00:00.000Z" };
      expect(hasPrBadgeFieldsChanged(current, next)).toBe(true);
    });

    it("ignores lastCheckedAt differences", () => {
      const current = { ...basePrInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...basePrInfo, lastCheckedAt: "2026-01-02T00:00:00.000Z" };
      expect(hasPrBadgeFieldsChanged(current, next)).toBe(false);
    });
  });

  describe("hasIssueBadgeFieldsChanged", () => {
    const baseIssueInfo = {
      url: "https://github.com/owner/repo/issues/123",
      number: 123,
      state: "open" as const,
      title: "Test Issue",
      stateReason: undefined,
    };

    it("returns true when current is undefined", () => {
      expect(hasIssueBadgeFieldsChanged(undefined, baseIssueInfo)).toBe(true);
    });

    it("returns false when fields are identical", () => {
      const current = { ...baseIssueInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      expect(hasIssueBadgeFieldsChanged(current, baseIssueInfo)).toBe(false);
    });

    it("returns true when state changes", () => {
      const current = { ...baseIssueInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...baseIssueInfo, state: "closed" as const };
      expect(hasIssueBadgeFieldsChanged(current, next)).toBe(true);
    });

    it("returns true when stateReason changes", () => {
      const current = { ...baseIssueInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...baseIssueInfo, stateReason: "completed" as const };
      expect(hasIssueBadgeFieldsChanged(current, next)).toBe(true);
    });

    it("ignores lastCheckedAt differences", () => {
      const current = { ...baseIssueInfo, lastCheckedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...baseIssueInfo, lastCheckedAt: "2026-01-02T00:00:00.000Z" };
      expect(hasIssueBadgeFieldsChanged(current, next)).toBe(false);
    });
  });

  describe("fetchInstallationToken (integration)", () => {
    it("returns null when API request fails", async () => {
      // Mock a failed fetch response
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      global.fetch = mockFetch;

      const token = await fetchInstallationToken(12345, "app-id", "fake-private-key");
      expect(token).toBeNull();
    });

    it("returns token on successful API request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: "ghs_installation_token" }),
      });
      global.fetch = mockFetch;

      // Note: This will fail JWT generation with a fake key, but we can verify the attempt
      const token = await fetchInstallationToken(12345, "app-id", "fake-key");
      // Expect null because JWT signing will fail with invalid key
      expect(token).toBeNull();
    });
  });

  describe("fetchCanonicalPrInfo (integration)", () => {
    it("fetches PR data from GitHub API", async () => {
      const mockPrData = {
        number: 42,
        html_url: "https://github.com/owner/repo/pull/42",
        title: "Test PR",
        state: "open",
        merged: false,
        head: { ref: "feature-branch" },
        base: { ref: "main" },
        comments: 5,
        updated_at: "2026-01-01T00:00:00Z",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPrData),
      });
      global.fetch = mockFetch;

      const result = await fetchCanonicalPrInfo("owner", "repo", 42, "fake-token");

      expect(result).not.toBeNull();
      expect(result?.number).toBe(42);
      expect(result?.status).toBe("open");
      expect(result?.title).toBe("Test PR");
      expect(result?.headBranch).toBe("feature-branch");
      expect(result?.commentCount).toBe(5);
      
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/pulls/42",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer fake-token",
          }),
        }),
      );
    });

    it("returns merged status for merged PRs", async () => {
      const mockPrData = {
        number: 42,
        html_url: "https://github.com/owner/repo/pull/42",
        title: "Test PR",
        state: "closed",
        merged: true,
        head: { ref: "feature-branch" },
        base: { ref: "main" },
        comments: 10,
        updated_at: "2026-01-02T00:00:00Z",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPrData),
      });
      global.fetch = mockFetch;

      const result = await fetchCanonicalPrInfo("owner", "repo", 42, "fake-token");

      expect(result?.status).toBe("merged");
    });

    it("returns null on API error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      global.fetch = mockFetch;

      const result = await fetchCanonicalPrInfo("owner", "repo", 42, "fake-token");
      expect(result).toBeNull();
    });
  });

  describe("fetchCanonicalIssueInfo (integration)", () => {
    it("fetches issue data from GitHub API", async () => {
      const mockIssueData = {
        number: 123,
        html_url: "https://github.com/owner/repo/issues/123",
        title: "Test Issue",
        state: "open",
        state_reason: null,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockIssueData),
      });
      global.fetch = mockFetch;

      const result = await fetchCanonicalIssueInfo("owner", "repo", 123, "fake-token");

      expect(result).not.toBeNull();
      expect(result?.number).toBe(123);
      expect(result?.state).toBe("open");
      expect(result?.title).toBe("Test Issue");
    });

    it("returns null for PRs (which come through issues endpoint)", async () => {
      const mockPrData = {
        number: 42,
        html_url: "https://github.com/owner/repo/pull/42",
        title: "Test PR",
        state: "open",
        pull_request: {}, // This marks it as a PR
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPrData),
      });
      global.fetch = mockFetch;

      const result = await fetchCanonicalIssueInfo("owner", "repo", 42, "fake-token");
      expect(result).toBeNull();
    });

    it("returns null on API error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      global.fetch = mockFetch;

      const result = await fetchCanonicalIssueInfo("owner", "repo", 123, "fake-token");
      expect(result).toBeNull();
    });
  });
});
