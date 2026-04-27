import { describe, expect, it, vi, afterEach } from "vitest";

describe("shell-utils", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each([
    ["win32", "cmd.exe"],
    ["linux", "/bin/sh"],
  ])("returns %s shell as %s", async (platform, expectedShell) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);

    const { defaultShell } = await import("../shell-utils.js");

    expect(defaultShell).toBe(expectedShell);
  });
});
