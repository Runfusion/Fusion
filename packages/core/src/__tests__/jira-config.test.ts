import { describe, expect, it } from "vitest";
import { isGlobalSettingsKey, isProjectSettingsKey, resolveJiraConfig, resolveJiraEnabled } from "@fusion/core";
describe("JIRA configuration", () => {
  it("is opt in and project setting wins", () => { expect(resolveJiraEnabled()).toBe(false); expect(resolveJiraEnabled({ project: { jiraEnabled: false }, global: { jiraEnabled: true } })).toBe(false); });
  it("derives cloud API URL and exposes dual-scope keys", () => { expect(resolveJiraConfig({ global: { jiraBaseUrl: "https://jira.example/prefix" } }).apiBaseUrl).toBe("https://jira.example/prefix/rest/api/3"); for (const key of ["jiraEnabled", "jiraBaseUrl", "jiraApiBaseUrl", "jiraAuthEmail", "jiraAuthTokenSecretKey", "jiraAuthTokenSecretScope", "jiraBranchNameTemplate"]) { expect(isGlobalSettingsKey(key)).toBe(true); expect(isProjectSettingsKey(key)).toBe(true); } });
});
