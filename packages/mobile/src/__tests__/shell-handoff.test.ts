import { describe, expect, it } from "vitest";
import { buildMobileShellHandoff } from "../plugins/shell-handoff.js";

describe("buildMobileShellHandoff", () => {
  it("builds remote handoff URL for valid active profile", () => {
    const result = buildMobileShellHandoff({
      host: "mobile-shell",
      activeProfileId: "profile_1",
      profiles: [
        {
          id: "profile_1",
          name: "Prod",
          serverUrl: "https://fusion.example.com/",
          authToken: "abc123",
          createdAt: "",
          updatedAt: "",
          lastUsedAt: null,
        },
      ],
    });

    expect(result.kind).toBe("remote-launch");
    if (result.kind !== "remote-launch") {
      throw new Error("expected remote-launch");
    }

    const url = new URL(result.url);
    expect(url.searchParams.get("shellKind")).toBe("mobile");
    expect(url.searchParams.get("shellMode")).toBe("remote");
    expect(url.searchParams.get("profileId")).toBe("profile_1");
    expect(url.searchParams.get("serverBaseUrl")).toBe("https://fusion.example.com");
    expect(url.searchParams.get("token")).toBe("abc123");
  });

  it("returns deterministic fallback when no active profile exists", () => {
    const result = buildMobileShellHandoff({
      host: "mobile-shell",
      activeProfileId: null,
      profiles: [],
    });

    expect(result).toEqual({ kind: "fallback", reason: "no-active-profile" });
  });

  it("returns fallback for invalid server URLs", () => {
    const result = buildMobileShellHandoff({
      host: "mobile-shell",
      activeProfileId: "profile_1",
      profiles: [
        {
          id: "profile_1",
          name: "Prod",
          serverUrl: "not-a-url",
          authToken: null,
          createdAt: "",
          updatedAt: "",
          lastUsedAt: null,
        },
      ],
    });

    expect(result).toEqual({ kind: "fallback", reason: "invalid-server-url" });
  });
});
