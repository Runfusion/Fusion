import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  content: new Map<string, string>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/fusion"),
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    const value = mockState.content.get(path);
    if (!value) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return value;
  }),
  writeFile: vi.fn(async (path: string, value: string) => {
    mockState.content.set(path, value);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const value = mockState.content.get(from) ?? "";
    mockState.content.set(to, value);
  }),
}));

describe("shell-settings", () => {
  beforeEach(() => {
    mockState.content.clear();
    vi.resetModules();
  });

  it("returns defaults when file missing", async () => {
    const { readShellSettings, getDesktopShellModeState } = await import("../shell-settings.ts");
    await expect(readShellSettings()).resolves.toEqual({
      desktopMode: null,
      hasCompletedModeSelection: false,
      activeProfileId: null,
      profiles: [],
    });
    const settings = await readShellSettings();
    expect(getDesktopShellModeState(settings)).toEqual({
      isFirstRun: true,
      desktopMode: null,
    });
  });

  it("writes and reads persisted settings", async () => {
    const { writeShellSettings, readShellSettings } = await import("../shell-settings.ts");

    await writeShellSettings({
      desktopMode: "local",
      hasCompletedModeSelection: true,
      activeProfileId: "p1",
      profiles: [
        {
          id: "p1",
          name: "Local",
          serverUrl: "http://127.0.0.1",
          authToken: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
    });

    await expect(readShellSettings()).resolves.toMatchObject({
      desktopMode: "local",
      hasCompletedModeSelection: true,
      activeProfileId: "p1",
      profiles: [{ id: "p1" }],
    });
  });

  it("infers completed selection from legacy desktopMode payload", async () => {
    mockState.content.set("/tmp/fusion/shell-connections.json", JSON.stringify({ desktopMode: "remote" }));
    const { readShellSettings, getDesktopShellModeState } = await import("../shell-settings.ts");
    const settings = await readShellSettings();
    expect(settings.hasCompletedModeSelection).toBe(true);
    expect(getDesktopShellModeState(settings)).toEqual({
      isFirstRun: false,
      desktopMode: "remote",
    });
  });

  it("treats invalid persisted mode as first-run", async () => {
    mockState.content.set(
      "/tmp/fusion/shell-connections.json",
      JSON.stringify({ desktopMode: "invalid", hasCompletedModeSelection: true }),
    );
    const { readShellSettings, getDesktopShellModeState } = await import("../shell-settings.ts");
    const settings = await readShellSettings();
    expect(getDesktopShellModeState(settings)).toEqual({
      isFirstRun: true,
      desktopMode: null,
    });
  });

  it("normalizes invalid profiles, duplicate names, and invalid active id", async () => {
    mockState.content.set(
      "/tmp/fusion/shell-connections.json",
      JSON.stringify({
        activeProfileId: "missing",
        profiles: [
          { id: "p1", name: "", serverUrl: "https://fusion.example.com" },
          { id: "p2", name: "Remote Server", serverUrl: "https://staging.example.com" },
          { id: "p3", name: "Bad", serverUrl: "not-a-url" },
        ],
      }),
    );

    const { readShellSettings } = await import("../shell-settings.ts");
    const settings = await readShellSettings();
    expect(settings.activeProfileId).toBeNull();
    expect(settings.profiles).toHaveLength(2);
    expect(settings.profiles[0]?.name).toBe("Remote Server");
    expect(settings.profiles[1]?.name).toBe("Remote Server (2)");
  });

  it("deleting active profile picks fallback and deleting last clears state", async () => {
    const { applyDeleteProfile } = await import("../shell-settings.ts");
    const first = { id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", authToken: null, createdAt: "", updatedAt: "" };
    const second = { id: "p2", name: "Staging", serverUrl: "https://staging.example.com", authToken: null, createdAt: "", updatedAt: "" };

    const withFallback = applyDeleteProfile({
      desktopMode: "remote",
      hasCompletedModeSelection: true,
      activeProfileId: "p2",
      profiles: [first, second],
    }, "p2");

    expect(withFallback.activeProfileId).toBe("p1");

    const empty = applyDeleteProfile({
      desktopMode: "remote",
      hasCompletedModeSelection: true,
      activeProfileId: "p1",
      profiles: [first],
    }, "p1");

    expect(empty).toMatchObject({ activeProfileId: null, profiles: [] });
  });
});
