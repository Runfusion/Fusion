import { describe, expect, it } from "vitest";
import { resolvePlanningSourceIssue } from "../planning.js";

const seed = [
  "Plan work for GitHub issue: Preserve source context",
  "",
  "Issue description:",
  "Verbatim issue body.",
  "",
  "Source: https://github.com/owner/repo/issues/42",
].join("\n");

describe("resolvePlanningSourceIssue", () => {
  it("falls back only to a canonical GitHub issue seed", () => {
    const resolved = resolvePlanningSourceIssue({ initialPlan: seed } as any);
    expect(resolved?.sourceIssue).toMatchObject({
      provider: "github",
      repository: "owner/repo",
      issueNumber: 42,
      url: "https://github.com/owner/repo/issues/42",
    });
    expect(resolved?.markdown).toContain("Verbatim issue body.");
    expect(resolvePlanningSourceIssue({ initialPlan: "Mention https://github.com/owner/repo/issues/42" } as any)).toBeUndefined();
  });

  it("uses persisted GitHub provenance over a conflicting seed", () => {
    const resolved = resolvePlanningSourceIssue({
      initialPlan: seed.replace("owner/repo/issues/42", "other/project/issues/7"),
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "42",
        issueNumber: 42,
        url: "https://github.com/owner/repo/issues/42",
        title: "Persisted title",
      },
    } as any);

    expect(resolved?.sourceIssue.repository).toBe("owner/repo");
    expect(resolved?.markdown).toContain("Persisted title");
    expect(resolved?.markdown).not.toContain("Verbatim issue body.");
  });

  it("enriches matching persisted GitHub provenance without accepting another provider", () => {
    const resolved = resolvePlanningSourceIssue({
      initialPlan: seed,
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "42",
        issueNumber: 42,
        url: "https://github.com/owner/repo/issues/42",
      },
    } as any);
    expect(resolved?.markdown).toContain("Verbatim issue body.");
    expect(resolvePlanningSourceIssue({
      initialPlan: seed,
      sourceIssue: { provider: "gitlab", repository: "group/project", issueNumber: 42, url: "https://gitlab.example.com/42" },
    } as any)).toBeUndefined();
  });
});
