import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
  },
}));

describe("connection-profiles", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("recovers from invalid payloads", async () => {
    store.set("fusion.shell.connections.v1", "{bad-json");
    const { loadShellProfiles } = await import("../connection-profiles.js");
    await expect(loadShellProfiles()).resolves.toEqual({ activeProfileId: null, profiles: [] });
  });

  it("normalizes empty and duplicate names", async () => {
    const { saveShellProfile, listShellProfiles } = await import("../connection-profiles.js");
    const first = await saveShellProfile({ name: "", serverUrl: "https://fusion.example.com" });
    const second = await saveShellProfile({ name: "Remote Server", serverUrl: "https://fusion-two.example.com" });

    expect(first.name).toBe("Remote Server");
    expect(second.name).toBe("Remote Server (2)");
    const profiles = await listShellProfiles();
    expect(profiles).toHaveLength(2);
  });

  it("deleting active profile picks a fallback and deleting final profile clears state", async () => {
    const { saveShellProfile, setActiveShellProfile, deleteShellProfile, loadShellProfiles } = await import("../connection-profiles.js");
    const first = await saveShellProfile({ name: "Prod", serverUrl: "https://fusion.example.com" });
    const second = await saveShellProfile({ name: "Staging", serverUrl: "https://staging.example.com" });
    await setActiveShellProfile(second.id);

    await deleteShellProfile(second.id);
    const afterFirstDelete = await loadShellProfiles();
    expect(afterFirstDelete.activeProfileId).toBe(first.id);

    await deleteShellProfile(first.id);
    const afterSecondDelete = await loadShellProfiles();
    expect(afterSecondDelete).toEqual({ activeProfileId: null, profiles: [] });
  });
});
