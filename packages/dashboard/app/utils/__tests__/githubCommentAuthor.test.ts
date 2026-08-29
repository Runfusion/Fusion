import { describe, expect, it } from "vitest";
import { resolveReviewCommentAuthor } from "../githubCommentAuthor";

describe("resolveReviewCommentAuthor", () => {
  it("classifies a human login and derives a GitHub avatar URL", () => {
    expect(resolveReviewCommentAuthor("octocat")).toEqual({
      author: "octocat",
      authorIsBot: false,
      authorAvatarUrl: "https://github.com/octocat.png?size=40",
    });
  });

  it("classifies bracket-suffixed bot logins without deriving an avatar", () => {
    expect(resolveReviewCommentAuthor("coderabbitai[bot]")).toEqual({
      author: "coderabbitai[bot]",
      authorIsBot: true,
      authorAvatarUrl: undefined,
    });
  });

  it("treats missing or empty pull-request logins as unknown without an avatar", () => {
    expect(resolveReviewCommentAuthor()).toEqual({
      author: "unknown",
      authorIsBot: false,
      authorAvatarUrl: undefined,
    });
    expect(resolveReviewCommentAuthor("   ")).toEqual({
      author: "unknown",
      authorIsBot: false,
      authorAvatarUrl: undefined,
    });
  });

  it("classifies reviewer-agent identities and missing direct-mode authors as agents", () => {
    expect(resolveReviewCommentAuthor("reviewer-agent")).toEqual({
      author: "reviewer-agent",
      authorIsBot: true,
      authorAvatarUrl: undefined,
    });
    expect(resolveReviewCommentAuthor(undefined, { reviewSource: "reviewer-agent" })).toEqual({
      author: "unknown",
      authorIsBot: true,
      authorAvatarUrl: undefined,
    });
  });
});
