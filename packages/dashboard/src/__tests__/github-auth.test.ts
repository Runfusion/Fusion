import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    isGhAvailable: vi.fn(),
    isGhAuthenticated: vi.fn(),
  };
});

import { isGhAuthenticated, isGhAvailable } from "@fusion/core";
import { resolveGithubTrackingAuth } from "../github-auth.js";

const mockIsGhAvailable = vi.mocked(isGhAvailable);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);

describe("resolveGithubTrackingAuth", () => {
  beforeEach(() => {
    mockIsGhAvailable.mockReset();
    mockIsGhAuthenticated.mockReset();
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
  });

  it("uses project token in token mode", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "token", githubAuthToken: "proj-token" },
      globalSettings: {},
      env: { GITHUB_TOKEN: "env-token" },
    });
    expect(result).toEqual({ ok: true, auth: { mode: "token", token: "proj-token" } });
  });

  it("falls back to env token in token mode", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "token", githubAuthToken: " " },
      globalSettings: {},
      env: { GITHUB_TOKEN: "env-token" },
    });
    expect(result).toEqual({ ok: true, auth: { mode: "token", token: "env-token" } });
  });

  it("returns token_missing when token mode has no token", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "token", githubAuthToken: "" },
      globalSettings: {},
      env: {},
    });
    expect(result).toMatchObject({ ok: false, requestedMode: "token", reason: "token_missing" });
    expect(mockIsGhAvailable).not.toHaveBeenCalled();
  });

  it("resolves gh-cli mode when gh is available and authenticated", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "gh-cli" },
      globalSettings: {},
    });
    expect(result).toEqual({ ok: true, auth: { mode: "gh-cli" } });
  });

  it("returns gh_not_installed when gh-cli mode has no gh", () => {
    mockIsGhAvailable.mockReturnValue(false);
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "gh-cli" },
      globalSettings: {},
    });
    expect(result).toMatchObject({ ok: false, requestedMode: "gh-cli", reason: "gh_not_installed" });
  });

  it("returns gh_not_authenticated when gh-cli mode is unauthenticated", () => {
    mockIsGhAuthenticated.mockReturnValue(false);
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "gh-cli" },
      globalSettings: {},
    });
    expect(result).toMatchObject({ ok: false, requestedMode: "gh-cli", reason: "gh_not_authenticated" });
  });

  it("defaults to gh-cli mode when githubAuthMode is undefined", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: {},
      globalSettings: {},
    });
    expect(result).toEqual({ ok: true, auth: { mode: "gh-cli" } });
  });

  it("uses global githubAuthMode/githubAuthToken fallback when present", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: {},
      globalSettings: { githubAuthMode: "token", githubAuthToken: "global-token" },
      env: {},
    });
    expect(result).toEqual({ ok: true, auth: { mode: "token", token: "global-token" } });
  });

  it("uses defensive projectGithubAuthMode/projectGithubAuthToken fallback keys", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: {},
      globalSettings: { projectGithubAuthMode: "token", projectGithubAuthToken: "project-global-token" },
      env: {},
    });
    expect(result).toEqual({ ok: true, auth: { mode: "token", token: "project-global-token" } });
  });

  it("returns invalid_mode for unsupported mode values", () => {
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "weird" as "gh-cli" },
      globalSettings: {},
    });
    expect(result).toMatchObject({ ok: false, requestedMode: "gh-cli", reason: "invalid_mode" });
  });

  it("does not cross-fallback from token mode to gh-cli", () => {
    mockIsGhAvailable.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    const result = resolveGithubTrackingAuth({
      projectSettings: { githubAuthMode: "token" },
      globalSettings: {},
      env: {},
    });
    expect(result).toMatchObject({ ok: false, requestedMode: "token", reason: "token_missing" });
    expect(mockIsGhAvailable).not.toHaveBeenCalled();
    expect(mockIsGhAuthenticated).not.toHaveBeenCalled();
  });
});
