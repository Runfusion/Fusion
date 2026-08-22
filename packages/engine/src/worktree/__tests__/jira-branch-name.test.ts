import { describe, expect, it } from "vitest";
import { deriveJiraBranchName, normalizeJiraIssueKey } from "../jira-branch-name.js";
describe("JIRA branch names", () => {
  it("derives the documented branch", () => expect(deriveJiraBranchName({ issueKey: "PRD-1234", summary: "My Slug" })).toEqual({ ok: true, branchName: "feature/PRD-1234-my-slug" }));
  it("normalizes keys and removes empty summary suffixes", () => { expect(normalizeJiraIssueKey(" prd-1234 ")).toBe("PRD-1234"); expect(deriveJiraBranchName({ issueKey: "PRD-1234", summary: "🎉 !!!" })).toEqual({ ok: true, branchName: "feature/PRD-1234" }); });
  it("rejects unknown template tokens", () => expect(deriveJiraBranchName({ issueKey: "PRD-1234", template: "{title}" })).toMatchObject({ ok: false, reason: "invalid_template" }));
});
