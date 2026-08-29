import { describe, expect, it } from "vitest";
import {
  validateDirectMergeCommitStrategy,
  validateGithubAuthMode,
  validateGithubRepoSlug,
  validateHeartbeatPromptTemplate,
  validateHeartbeatScopeDisciplineMode,
  validateUnavailableNodePolicy,
} from "../config/settings-validation.js";

describe("settings-validation", () => {
  describe("validateUnavailableNodePolicy", () => {
    it("accepts supported policies", () => {
      expect(validateUnavailableNodePolicy("block")).toBe("block");
      expect(validateUnavailableNodePolicy("fallback-local")).toBe("fallback-local");
    });

    it("returns undefined for invalid values", () => {
      expect(validateUnavailableNodePolicy("fallback")).toBeUndefined();
      expect(validateUnavailableNodePolicy(123)).toBeUndefined();
      expect(validateUnavailableNodePolicy(undefined)).toBeUndefined();
    });
  });

  describe("validateDirectMergeCommitStrategy", () => {
    it("accepts supported direct-merge routing values", () => {
      expect(validateDirectMergeCommitStrategy("auto")).toBe("auto");
      expect(validateDirectMergeCommitStrategy("always-squash")).toBe("always-squash");
      expect(validateDirectMergeCommitStrategy("always-rebase")).toBe("always-rebase");
    });

    it("returns undefined for invalid routing values", () => {
      expect(validateDirectMergeCommitStrategy("squash")).toBeUndefined();
      expect(validateDirectMergeCommitStrategy(123)).toBeUndefined();
      expect(validateDirectMergeCommitStrategy(undefined)).toBeUndefined();
    });
  });

  describe("validateGithubAuthMode", () => {
    it("accepts supported auth modes", () => {
      expect(validateGithubAuthMode("gh-cli")).toBe("gh-cli");
      expect(validateGithubAuthMode("token")).toBe("token");
    });

    it("returns undefined for invalid values", () => {
      expect(validateGithubAuthMode("oauth")).toBeUndefined();
      expect(validateGithubAuthMode(123)).toBeUndefined();
      expect(validateGithubAuthMode(undefined)).toBeUndefined();
    });
  });

  describe("validateHeartbeatScopeDisciplineMode", () => {
    it("accepts supported modes", () => {
      expect(validateHeartbeatScopeDisciplineMode("strict")).toBe("strict");
      expect(validateHeartbeatScopeDisciplineMode("lite")).toBe("lite");
      expect(validateHeartbeatScopeDisciplineMode("off")).toBe("off");
    });

    it("returns undefined for invalid values", () => {
      expect(validateHeartbeatScopeDisciplineMode("minimal")).toBeUndefined();
      expect(validateHeartbeatScopeDisciplineMode(123)).toBeUndefined();
      expect(validateHeartbeatScopeDisciplineMode(undefined)).toBeUndefined();
    });
  });

  describe("validateHeartbeatPromptTemplate", () => {
    it("accepts supported templates", () => {
      expect(validateHeartbeatPromptTemplate("default")).toBe("default");
      expect(validateHeartbeatPromptTemplate("compact")).toBe("compact");
    });

    it("returns undefined for invalid values", () => {
      expect(validateHeartbeatPromptTemplate("tiny")).toBeUndefined();
      expect(validateHeartbeatPromptTemplate(123)).toBeUndefined();
      expect(validateHeartbeatPromptTemplate(undefined)).toBeUndefined();
    });
  });

  describe("validateGithubRepoSlug", () => {
    it("accepts valid owner/repo slugs", () => {
      expect(validateGithubRepoSlug("owner/repo")).toBe("owner/repo");
      expect(validateGithubRepoSlug("Owner.Name/repo_name-1")).toBe("Owner.Name/repo_name-1");
    });

    it("treats empty strings as unset", () => {
      expect(validateGithubRepoSlug("")).toBeUndefined();
      expect(validateGithubRepoSlug("   ")).toBeUndefined();
    });

    it("returns undefined for malformed slugs and invalid types", () => {
      expect(validateGithubRepoSlug("owner")).toBeUndefined();
      expect(validateGithubRepoSlug("owner/repo/extra")).toBeUndefined();
      expect(validateGithubRepoSlug("owner repo/repo")).toBeUndefined();
      expect(validateGithubRepoSlug(42)).toBeUndefined();
      expect(validateGithubRepoSlug(undefined)).toBeUndefined();
    });
  });
});
