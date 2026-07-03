import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITLAB_API_BASE_URL,
  DEFAULT_GITLAB_INSTANCE_URL,
  resolveGitlabConfig,
  resolveGitlabEnabled,
} from "../gitlab-config.js";

/*
FNXC:GitLabConfiguration 2026-07-02-00:00:
These tests pin FN-7422 as configuration-only groundwork: GitLab.com is the blank default, project settings override global fallbacks, and invalid URL forms fail before future GitLab API clients can use persisted settings.
*/
describe("resolveGitlabConfig", () => {
  it("defaults to GitLab.com when no settings are configured", () => {
    expect(resolveGitlabConfig()).toEqual({
      enabled: true,
      instanceUrl: DEFAULT_GITLAB_INSTANCE_URL,
      apiBaseUrl: DEFAULT_GITLAB_API_BASE_URL,
    });
  });

  it("uses project overrides before global fallbacks", () => {
    expect(
      resolveGitlabConfig({
        global: { gitlabInstanceUrl: "https://global.example/gitlab", gitlabApiBaseUrl: "https://global.example/api/v4" },
        project: { gitlabInstanceUrl: "https://project.example/gitlab", gitlabApiBaseUrl: "https://project.example/rest" },
      }),
    ).toEqual({
      enabled: true,
      instanceUrl: "https://project.example/gitlab",
      apiBaseUrl: "https://project.example/rest",
    });
  });

  it("uses global fallbacks when project settings are blank", () => {
    expect(
      resolveGitlabConfig({
        global: { gitlabInstanceUrl: " https://global.example/gitlab/ ", gitlabApiBaseUrl: " https://global.example/gitlab/api/v4/ " },
        project: { gitlabInstanceUrl: " ", gitlabApiBaseUrl: "" },
      }),
    ).toEqual({
      enabled: true,
      instanceUrl: "https://global.example/gitlab",
      apiBaseUrl: "https://global.example/gitlab/api/v4",
    });
  });

  it("derives the API base URL from a self-managed path prefix", () => {
    expect(resolveGitlabConfig({ project: { gitlabInstanceUrl: "https://example.com/gitlab/" } })).toEqual({
      enabled: true,
      instanceUrl: "https://example.com/gitlab",
      apiBaseUrl: "https://example.com/gitlab/api/v4",
    });
  });

  it("allows explicit API base URL overrides", () => {
    expect(
      resolveGitlabConfig({
        project: { gitlabInstanceUrl: "https://gitlab.example", gitlabApiBaseUrl: "https://api.example/custom/v4/" },
      }),
    ).toEqual({ enabled: true, instanceUrl: "https://gitlab.example", apiBaseUrl: "https://api.example/custom/v4" });
  });

  it("treats blank strings as cleared defaults", () => {
    expect(resolveGitlabConfig({ project: { gitlabInstanceUrl: " ", gitlabApiBaseUrl: "\t" } })).toEqual({
      enabled: true,
      instanceUrl: DEFAULT_GITLAB_INSTANCE_URL,
      apiBaseUrl: DEFAULT_GITLAB_API_BASE_URL,
    });
  });


  it("resolves effective enabled state with project-over-global precedence", () => {
    expect(resolveGitlabEnabled()).toBe(true);
    expect(resolveGitlabEnabled({ global: { gitlabEnabled: false } })).toBe(false);
    expect(resolveGitlabEnabled({ global: { gitlabEnabled: false }, project: { gitlabEnabled: true } })).toBe(true);
    expect(resolveGitlabEnabled({ global: { gitlabEnabled: true }, project: { gitlabEnabled: false } })).toBe(false);
    expect(resolveGitlabConfig({ global: { gitlabEnabled: false } })).toMatchObject({ enabled: false });
  });

  it.each([
    ["GitLab instance URL", { project: { gitlabInstanceUrl: "ssh://gitlab.example" } }],
    ["GitLab instance URL", { project: { gitlabInstanceUrl: "https://user:pass@gitlab.example" } }],
    ["GitLab API base URL", { project: { gitlabApiBaseUrl: "ftp://gitlab.example/api/v4" } }],
    ["GitLab API base URL", { project: { gitlabApiBaseUrl: "https://token@gitlab.example/api/v4" } }],
  ])("rejects invalid %s settings", (_label, input) => {
    expect(() => resolveGitlabConfig(input)).toThrow(/GitLab .* URL/);
  });
});
