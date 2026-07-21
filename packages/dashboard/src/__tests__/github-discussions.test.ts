import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionsDisabledError, GitHubClient } from "../github.js";

describe("GitHub Discussions GraphQL transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists repository discussion categories through the authenticated GraphQL transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { repository: { discussionCategories: { nodes: [
        { id: "DC_1", name: "Ideas", slug: "ideas" },
        { id: "DC_2", name: "General", slug: "general" },
      ] } } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const categories = await new GitHubClient({ token: "test", forceMode: "token" }).listDiscussionCategories("Runfusion", "Fusion");

    expect(categories).toEqual([
      { id: "DC_1", name: "Ideas", slug: "ideas" },
      { id: "DC_2", name: "General", slug: "general" },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.github.com/graphql");
  });

  it("surfaces GraphQL scope or disabled-Discussions failures to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: "Resource not accessible by personal access token" }],
    }), { status: 200 })));

    await expect(new GitHubClient({ token: "test", forceMode: "token" }).listDiscussionCategories("Runfusion", "Fusion"))
      .rejects.toThrow("Resource not accessible by personal access token");
  });

  it("creates a discussion through the forced token GraphQL transport", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { repository: { id: "R_1", discussionCategories: { nodes: [{ id: "DC_1" }] } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { createDiscussion: { discussion: { id: "D_1", number: 42, url: "https://github.com/Runfusion/Fusion/discussions/42" } } },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const discussion = await new GitHubClient({ token: "test", forceMode: "token" })
      .createDiscussion("Runfusion", "Fusion", "Title", "Body", "DC_1");

    expect(discussion).toEqual({ id: "D_1", number: 42, htmlUrl: "https://github.com/Runfusion/Fusion/discussions/42" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === "https://api.github.com/graphql")).toBe(true);
  });

  it("maps disabled Discussions errors from search to a typed signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: "Discussions are disabled for this repository" }],
    }), { status: 200 })));

    await expect(new GitHubClient({ token: "test", forceMode: "token" }).searchDiscussions("Runfusion", "Fusion", "report"))
      .rejects.toBeInstanceOf(DiscussionsDisabledError);
  });

  it("maps disabled Discussions errors from create to the same typed signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: "Discussions are not enabled for this repository" }],
    }), { status: 200 })));

    await expect(new GitHubClient({ token: "test", forceMode: "token" }).createDiscussion("Runfusion", "Fusion", "Title", "Body", "DC_1"))
      .rejects.toBeInstanceOf(DiscussionsDisabledError);
  });

  it("uses the first category when the selected category is stale", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { repository: { id: "R_1", discussionCategories: { nodes: [{ id: "DC_1" }] } } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { createDiscussion: { discussion: { id: "D_1", number: 1, url: "https://github.com/Runfusion/Fusion/discussions/1" } } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new GitHubClient({ token: "test", forceMode: "token" }).createDiscussion("Runfusion", "Fusion", "Title", "Body", "stale-category");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).variables.categoryId).toBe("DC_1");
  });

});
