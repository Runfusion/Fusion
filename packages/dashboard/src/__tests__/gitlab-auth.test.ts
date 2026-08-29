import { describe, expect, it } from "vitest";
import { resolveGitlabAuth } from "../gitlab-auth.js";

/*
FNXC:GitLabAuthentication 2026-07-02-00:00:
These tests pin FN-7423's credential contract for later GitLab runtime tasks: configured tokens beat fallbacks, all supported token families resolve through PRIVATE-TOKEN, unset type defaults to personal, and unsupported token types fail instead of silently downgrading.
*/
describe("resolveGitlabAuth", () => {
  it.each(["personal", "project", "group"] as const)("resolves %s access tokens with PRIVATE-TOKEN metadata", (tokenType) => {
    expect(
      resolveGitlabAuth({
        projectSettings: {
          gitlabInstanceUrl: "https://gitlab.example.com/gitlab",
          gitlabAuthToken: ` ${tokenType}_token `,
          gitlabAuthTokenType: tokenType,
        },
        env: {},
      }),
    ).toEqual({
      ok: true,
      auth: {
        apiBaseUrl: "https://gitlab.example.com/gitlab/api/v4",
        webBaseUrl: "https://gitlab.example.com/gitlab",
        token: `${tokenType}_token`,
        tokenType,
        headerName: "PRIVATE-TOKEN",
      },
    });
  });

  it("defaults token type to personal when a token exists without an explicit type", () => {
    expect(resolveGitlabAuth({ projectSettings: { gitlabAuthToken: "glpat_project" }, env: {} })).toMatchObject({
      ok: true,
      auth: { tokenType: "personal", headerName: "PRIVATE-TOKEN" },
    });
  });

  it("uses project token and project type before global fallback settings", () => {
    expect(
      resolveGitlabAuth({
        projectSettings: { gitlabAuthToken: " project-token ", gitlabAuthTokenType: "project" },
        globalSettings: { gitlabAuthToken: "global-token", gitlabAuthTokenType: "group" },
        env: { GITLAB_TOKEN: "env-token" },
      }),
    ).toMatchObject({ ok: true, auth: { token: "project-token", tokenType: "project" } });
  });

  it("uses global token fallback before GITLAB_TOKEN", () => {
    expect(
      resolveGitlabAuth({
        projectSettings: { gitlabAuthToken: " " },
        globalSettings: { gitlabAuthToken: " global-token ", gitlabAuthTokenType: "group" },
        env: { GITLAB_TOKEN: "env-token" },
      }),
    ).toMatchObject({ ok: true, auth: { token: "global-token", tokenType: "group" } });
  });

  it("uses GITLAB_TOKEN fallback without adding a GitLab CLI dependency", () => {
    const resolution = resolveGitlabAuth({ projectSettings: {}, globalSettings: {}, env: { GITLAB_TOKEN: " env-token " } });
    expect(resolution).toMatchObject({ ok: true, auth: { token: "env-token", tokenType: "personal" } });
    expect(JSON.stringify(resolution)).not.toMatch(/glab|cli/i);
  });


  it("returns disabled before validating URL or token settings", () => {
    expect(
      resolveGitlabAuth({
        projectSettings: { gitlabEnabled: false, gitlabInstanceUrl: "not-a-url", gitlabAuthTokenType: "deploy" },
        globalSettings: { gitlabEnabled: true, gitlabAuthToken: "global-token" },
        env: { GITLAB_TOKEN: "env-token" },
      }),
    ).toEqual({
      ok: false,
      reason: "disabled",
      message: "GitLab integration is disabled in Settings.",
    });
  });

  it("uses project enabled state before global enabled fallback", () => {
    expect(resolveGitlabAuth({ projectSettings: { gitlabEnabled: true, gitlabAuthToken: "token" }, globalSettings: { gitlabEnabled: false }, env: {} })).toMatchObject({ ok: true });
    expect(resolveGitlabAuth({ projectSettings: {}, globalSettings: { gitlabEnabled: false, gitlabAuthToken: "token" }, env: {} })).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("returns token_missing when configured settings and GITLAB_TOKEN are blank", () => {
    expect(
      resolveGitlabAuth({
        projectSettings: { gitlabAuthToken: " \t " },
        globalSettings: { gitlabAuthToken: "" },
        env: { GITLAB_TOKEN: " " },
      }),
    ).toEqual({
      ok: false,
      reason: "token_missing",
      message: "GitLab auth requires gitlabAuthToken or GITLAB_TOKEN.",
    });
  });

  it("rejects unsupported token types", () => {
    expect(
      resolveGitlabAuth({
        projectSettings: { gitlabAuthToken: "token", gitlabAuthTokenType: "deploy" },
        env: {},
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_token_type",
      message: "Invalid gitlabAuthTokenType. Expected \"personal\", \"project\", or \"group\".",
    });
  });

  it("surfaces invalid GitLab URL configuration without network calls", () => {
    expect(
      resolveGitlabAuth({
        projectSettings: { gitlabInstanceUrl: "ftp://gitlab.example.com", gitlabAuthToken: "token" },
        env: {},
      }),
    ).toMatchObject({ ok: false, reason: "invalid_config" });
  });
});
