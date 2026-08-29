import { describe, expect, it } from "vitest";
import { selectIntegrationBranch } from "../git/integration-branch-readiness.js";

describe("selectIntegrationBranch", () => {
  it("prefers an explicitly configured branch over every inferred candidate", () => {
    expect(selectIntegrationBranch({
      configuredBranch: "release/1.0",
      originHeadBranch: "develop",
      localBranches: ["main"],
      currentBranch: "main",
      remoteBranches: ["trunk"],
    })).toEqual({ branch: "release/1.0", source: "configured" });
  });

  it("prefers origin/HEAD over local and remote candidates", () => {
    expect(selectIntegrationBranch({
      originHeadBranch: "develop",
      localBranches: ["main"],
      currentBranch: "main",
      remoteBranches: ["trunk"],
    })).toEqual({ branch: "develop", source: "origin-head" });
  });

  it("adopts master when it is the only well-known local branch", () => {
    expect(selectIntegrationBranch({ localBranches: ["master"] })).toEqual({
      branch: "master",
      source: "well-known-local",
    });
  });

  it("prefers main over master when both are local", () => {
    expect(selectIntegrationBranch({ localBranches: ["master", "main"] })).toEqual({
      branch: "main",
      source: "well-known-local",
    });
  });

  it("uses the current local branch when no well-known local branch exists", () => {
    expect(selectIntegrationBranch({
      localBranches: ["alpha", "develop-topic"],
      currentBranch: "develop-topic",
    })).toEqual({ branch: "develop-topic", source: "current-head" });
  });

  it("uses a sole local branch from detached HEAD", () => {
    expect(selectIntegrationBranch({ localBranches: ["release/1.0"] })).toEqual({
      branch: "release/1.0",
      source: "sole-local",
    });
  });

  it("adopts the sole remote-tracking branch when no local branch is available", () => {
    expect(selectIntegrationBranch({
      localBranches: [],
      remoteBranches: ["develop"],
    })).toEqual({ branch: "develop", source: "remote-tracking" });
  });

  it("prefers a well-known remote branch when remote inference has choices", () => {
    expect(selectIntegrationBranch({
      localBranches: [],
      remoteBranches: ["topic", "main"],
    })).toEqual({ branch: "main", source: "remote-tracking" });
  });

  it("refuses ambiguous remote-only branch sets", () => {
    expect(selectIntegrationBranch({
      localBranches: [],
      remoteBranches: ["alpha", "beta"],
    })).toBeNull();
  });

  it("never lets remote inference override an available local branch", () => {
    expect(selectIntegrationBranch({
      localBranches: ["release/1.0"],
      remoteBranches: ["main"],
    })).toEqual({ branch: "release/1.0", source: "sole-local" });
  });

  it("never infers Fusion sibling branches", () => {
    expect(selectIntegrationBranch({
      localBranches: ["fusion/fn-123"],
      remoteBranches: ["fusion/fn-456"],
    })).toBeNull();
  });

  it("treats blank configured and origin-head values as unset", () => {
    expect(selectIntegrationBranch({
      configuredBranch: "  ",
      originHeadBranch: "\t",
      localBranches: [" master "],
    })).toEqual({ branch: "master", source: "well-known-local" });
  });
});
