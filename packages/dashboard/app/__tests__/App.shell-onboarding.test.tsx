import { describe, expect, it } from "vitest";
import { requiresNativeShellOnboarding } from "../App";

describe("App shell onboarding gating", () => {
  it("requires onboarding for mobile shell without active profile", () => {
    expect(
      requiresNativeShellOnboarding(
        { host: "mobile-shell", activeProfileId: null },
        true,
        false,
      ),
    ).toBe(true);
  });

  it("requires onboarding for desktop remote mode without active profile", () => {
    expect(
      requiresNativeShellOnboarding(
        { host: "desktop-shell", desktopMode: "remote", activeProfileId: null },
        true,
        false,
      ),
    ).toBe(true);
  });

  it("skips onboarding for desktop local mode", () => {
    expect(
      requiresNativeShellOnboarding(
        { host: "desktop-shell", desktopMode: "local", activeProfileId: null },
        true,
        false,
      ),
    ).toBe(false);
  });

  it("skips onboarding when an active shell profile exists", () => {
    expect(
      requiresNativeShellOnboarding(
        { host: "mobile-shell", activeProfileId: "profile-1" },
        true,
        false,
      ),
    ).toBe(false);
  });

  it("re-requires onboarding after active profile is removed", () => {
    expect(
      requiresNativeShellOnboarding(
        { host: "desktop-shell", desktopMode: "remote", activeProfileId: null },
        true,
        false,
      ),
    ).toBe(true);
  });

  it("skips onboarding for web host", () => {
    expect(
      requiresNativeShellOnboarding(
        { host: "web", activeProfileId: null },
        true,
        false,
      ),
    ).toBe(false);
  });
});
