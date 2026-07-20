import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../github.js";

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

  it("requires callers to provide a validated category instead of choosing the first one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { repository: { id: "R_1", discussionCategories: { nodes: [{ id: "DC_1" }] } } },
    }), { status: 200 })));

    await expect(new GitHubClient({ token: "test", forceMode: "token" }).createDiscussion("Runfusion", "Fusion", "Title", "Body"))
      .rejects.toThrow("Discussion category is unavailable");
  });

});
