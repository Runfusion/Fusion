import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { API_JSON_HEADERS } from "../test/apiRequestHeaders";
import {
  fetchDiscoveredSkills,
  toggleExecutionSkill,
  installSkill,
  fetchSkillsCatalog,
  type DiscoveredSkill,
  type CatalogFetchResult,
  type ToggleSkillResult,
} from "../api";

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json",
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

describe("fetchDiscoveredSkills", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches discovered skills without projectId", async () => {
    const skills: DiscoveredSkill[] = [
      {
        id: "test-package::skills/test-skill/SKILL.md",
        name: "test-skill",
        path: "/path/to/skills/test-skill/SKILL.md",
        relativePath: "skills/test-skill/SKILL.md",
        enabled: true,
        metadata: {
          source: "test-package",
          scope: "project",
          origin: "package",
        },
      },
    ];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { skills }));

    const result = await fetchDiscoveredSkills();

    expect(result).toEqual(skills);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/discovered",
      expect.objectContaining({
        headers: API_JSON_HEADERS,
      }),
    );
  });

  it("fetches discovered skills with projectId", async () => {
    const skills: DiscoveredSkill[] = [];
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { skills }));

    await fetchDiscoveredSkills("proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/discovered?projectId=proj_123",
      expect.objectContaining({
        headers: API_JSON_HEADERS,
      }),
    );
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Failed to discover skills" }, 500),
    );

    await expect(fetchDiscoveredSkills()).rejects.toThrow("Failed to discover skills");
  });
});

describe("toggleExecutionSkill", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("toggles skill without projectId", async () => {
    const result: ToggleSkillResult = {
      settingsPath: "skills",
      pattern: "+test-skill",
      targetFile: "/path/to/settings.json",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

    const output = await toggleExecutionSkill(
      "test-package::skills/test-skill/SKILL.md",
      true,
    );

    expect(output).toEqual(result);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/execution",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          skillId: "test-package::skills/test-skill/SKILL.md",
          enabled: true,
        }),
      }),
    );
  });

  it("toggles skill with projectId", async () => {
    const result: ToggleSkillResult = {
      settingsPath: "packages[].skills",
      pattern: "-test-skill",
      targetFile: "/path/to/settings.json",
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

    await toggleExecutionSkill(
      "test-package::skills/test-skill/SKILL.md",
      false,
      "proj_456",
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/execution?projectId=proj_456",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          skillId: "test-package::skills/test-skill/SKILL.md",
          enabled: false,
        }),
      }),
    );
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Skill not found" }, 404),
    );

    await expect(
      toggleExecutionSkill("invalid-skill", true),
    ).rejects.toThrow("Skill not found");
  });
});

describe("installSkill", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts install requests without projectId", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    const output = await installSkill("owner/repo", "skill-name");

    expect(output).toEqual({ success: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/install",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "owner/repo", skill: "skill-name" }),
      }),
    );
  });

  it("includes projectId in install requests", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { success: true }));

    await installSkill("owner/repo", undefined, "proj_123");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/install?projectId=proj_123",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "owner/repo", skill: undefined }),
      }),
    );
  });

  it("propagates install errors", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "installer failed", code: "install_failed" }, 502),
    );

    await expect(installSkill("owner/repo", undefined)).rejects.toThrow("installer failed");
  });
});

describe("fetchSkillsCatalog", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches catalog with default parameters", async () => {
    const result: CatalogFetchResult = {
      entries: [
        {
          id: "skill-1",
          slug: "skill-one",
          name: "Skill One",
          description: "A test skill",
          installation: {
            installed: false,
            matchingSkillIds: [],
            matchingPaths: [],
          },
        },
      ],
      auth: {
        mode: "unauthenticated",
        tokenPresent: false,
        fallbackUsed: false,
      },
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

    const output = await fetchSkillsCatalog();

    expect(output).toEqual(result);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/catalog",
      expect.objectContaining({
        headers: API_JSON_HEADERS,
      }),
    );
  });

  it("fetches catalog with query and limit", async () => {
    const result: CatalogFetchResult = {
      entries: [],
      auth: {
        mode: "authenticated",
        tokenPresent: true,
        fallbackUsed: false,
      },
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

    await fetchSkillsCatalog("react", 10);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/catalog?q=react&limit=10",
      expect.objectContaining({
        headers: API_JSON_HEADERS,
      }),
    );
  });

  it("fetches catalog with projectId", async () => {
    const result: CatalogFetchResult = {
      entries: [],
      auth: {
        mode: "unauthenticated",
        tokenPresent: false,
        fallbackUsed: false,
      },
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

    await fetchSkillsCatalog(undefined, undefined, "proj_789");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/catalog?projectId=proj_789",
      expect.objectContaining({
        headers: API_JSON_HEADERS,
      }),
    );
  });

  it("combines query, limit, and projectId", async () => {
    const result: CatalogFetchResult = {
      entries: [],
      auth: {
        mode: "unauthenticated",
        tokenPresent: false,
        fallbackUsed: false,
      },
    };
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, result));

    await fetchSkillsCatalog("typescript", 5, "proj_abc");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/skills/catalog?q=typescript&limit=5&projectId=proj_abc",
      expect.objectContaining({
        headers: API_JSON_HEADERS,
      }),
    );
  });

  it("throws on error response", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchResponse(false, { error: "Upstream request timed out" }, 500),
    );

    await expect(fetchSkillsCatalog()).rejects.toThrow(
      "Upstream request timed out",
    );
  });
});
