import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSkillsAdapter } from "../skills-adapter.js";

describe("createSkillsAdapter - fetchCatalog fallback behavior", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.SKILLS_SH_TOKEN;
  });

  it("falls back to public search endpoint when authenticated endpoint returns 400", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [{ id: "s1", name: "Found Skill", skillId: "s1" }],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Found Skill");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });

  it("falls back to public search endpoint on 401", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [{ id: "s2", name: "Fallback Skill", skillId: "s2" }],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Fallback Skill");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });

  it("falls back to public search endpoint on 403", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: () => Promise.resolve(null),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [{ id: "s3", name: "Forbidden Fallback", skillId: "s3" }],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(2);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Forbidden Fallback");
      expect(result.auth.fallbackUsed).toBe(true);
    }
  });

  it("returns UpstreamError when authenticated endpoint returns 500", async () => {
    process.env.SKILLS_SH_TOKEN = "test-token";

    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCallCount++;
      if (urlStr.includes("/api/v1/skills")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.resolve(null),
        });
      }
      // This should NOT be called
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () =>
          Promise.resolve({
            skills: [],
          }),
      });
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(fetchCallCount).toBe(1);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.code).toBe("upstream_http_error");
      expect(result.error).toContain("500");
    }
  });

  it("uses public search endpoint when no token is present", async () => {
    // Ensure no token
    delete process.env.SKILLS_SH_TOKEN;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: () =>
        Promise.resolve({
          skills: [{ id: "s4", name: "Public Skill", skillId: "s4" }],
        }),
    }) as unknown as typeof fetch;

    const adapter = createSkillsAdapter({
      packageManager: { resolve: vi.fn().mockResolvedValue({ skills: [] }) },
      getSettingsPath: vi.fn().mockReturnValue("/tmp/settings.json"),
    });

    const result = await adapter.fetchCatalog({ limit: 20, query: "test" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect("entries" in result).toBe(true);
    if ("entries" in result) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("Public Skill");
      expect(result.auth.tokenPresent).toBe(false);
      expect(result.auth.fallbackUsed).toBe(false);
    }
  });
});
