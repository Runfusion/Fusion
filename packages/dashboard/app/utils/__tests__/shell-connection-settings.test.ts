import { describe, expect, it, vi } from "vitest";
import {
  createOrUpdateProfile,
  DEFAULT_WEB_SHELL_STATE,
  deleteProfile,
  normalizeShellState,
  selectActiveProfile,
} from "../shell-connection-settings";

describe("shell-connection-settings", () => {
  it("normalizes missing active profile to null", () => {
    const state = normalizeShellState({
      host: "mobile-shell",
      activeProfileId: "missing",
      profiles: [{ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" }],
    });

    expect(state.activeProfileId).toBeNull();
    expect(state.profiles).toHaveLength(1);
  });

  it("returns web fallback for empty shell state", () => {
    expect(normalizeShellState(undefined)).toEqual(DEFAULT_WEB_SHELL_STATE);
  });

  it("throws unsupported errors in browser mode", async () => {
    await expect(createOrUpdateProfile(null, { name: "Prod", serverUrl: "https://fusion.example.com" })).rejects.toThrow(
      "Saving connection profiles is only available in native shell mode",
    );
    await expect(deleteProfile(null, "p1")).rejects.toThrow("Deleting connection profiles is only available in native shell mode");
    await expect(selectActiveProfile(null, "p1")).rejects.toThrow(
      "Switching connection profiles is only available in native shell mode",
    );
  });

  it("delegates profile actions to shell API", async () => {
    const shellApi = {
      saveProfile: vi.fn(async () => ({ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" })),
      deleteProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => ({ host: "mobile-shell", activeProfileId: "p1", profiles: [] })),
    } as const;

    await createOrUpdateProfile(shellApi as never, { name: "Prod", serverUrl: "https://fusion.example.com" });
    await deleteProfile(shellApi as never, "p1");
    await selectActiveProfile(shellApi as never, "p1");

    expect(shellApi.saveProfile).toHaveBeenCalled();
    expect(shellApi.deleteProfile).toHaveBeenCalledWith("p1");
    expect(shellApi.setActiveProfile).toHaveBeenCalledWith("p1");
  });
});
