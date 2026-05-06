import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: storage.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      storage.set(key, value);
    }),
  },
}));

describe("connection-profiles", () => {
  beforeEach(() => {
    storage.clear();
    vi.resetModules();
  });

  it("persists and lists profiles", async () => {
    const { saveShellProfile, listShellProfiles } = await import("../plugins/connection-profiles.js");

    await saveShellProfile({ name: "Prod", serverUrl: "https://fusion.example.com/", authToken: "token" });
    const profiles = await listShellProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "Prod",
      serverUrl: "https://fusion.example.com",
      authToken: "token",
    });
  });

  it("rejects invalid server URLs", async () => {
    const { saveShellProfile } = await import("../plugins/connection-profiles.js");

    await expect(saveShellProfile({ name: "Prod", serverUrl: "not-a-url" })).rejects.toThrow(
      "Server URL must be a valid absolute URL",
    );
    await expect(saveShellProfile({ name: "Prod", serverUrl: "ftp://fusion.example.com" })).rejects.toThrow(
      "Server URL must use http or https",
    );
  });

  it("clears active profile when deleted", async () => {
    const { saveShellProfile, setActiveShellProfile, loadShellProfiles, deleteShellProfile } = await import("../plugins/connection-profiles.js");

    const profile = await saveShellProfile({ name: "Prod", serverUrl: "https://fusion.example.com" });
    await setActiveShellProfile(profile.id);
    await deleteShellProfile(profile.id);

    const state = await loadShellProfiles();
    expect(state.activeProfileId).toBeNull();
    expect(state.profiles).toHaveLength(0);
  });
});
