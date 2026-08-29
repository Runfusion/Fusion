import { describe, expect, it } from "vitest";
import { probeBrowserExecutable } from "../probe.js";

describe("probeBrowserExecutable", () => {
  it("reports unavailable with a reason when an explicit path does not exist", async () => {
    const result = await probeBrowserExecutable({ executablePath: "/definitely/not/a/browser/here" });
    expect(result.available).toBe(false);
    expect(result.reason).toContain("/definitely/not/a/browser/here");
  });

  it("accepts an explicit executable path that exists and is executable", async () => {
    // process.execPath (node itself) exists and is executable on all platforms.
    const result = await probeBrowserExecutable({ executablePath: process.execPath });
    expect(result.available).toBe(true);
    expect(result.executablePath).toBe(process.execPath);
  });

  it("honors the FUSION_BROWSER_EXECUTABLE env override", async () => {
    const result = await probeBrowserExecutable({ env: { FUSION_BROWSER_EXECUTABLE: process.execPath } as NodeJS.ProcessEnv });
    expect(result.available).toBe(true);
    expect(result.executablePath).toBe(process.execPath);
  });

  it("reports unavailable (not throw) when nothing is discoverable", async () => {
    // An env with no overrides and PATH that cannot resolve browser binaries.
    const result = await probeBrowserExecutable({
      env: { PATH: "/nonexistent-bin-dir" } as NodeJS.ProcessEnv,
    });
    // On a CI box without a system Chrome this is false; if a system Chrome is at
    // a well-known path it could be true. Either way it must not throw and must
    // carry a coherent shape.
    expect(typeof result.available).toBe("boolean");
    if (!result.available) expect(result.reason).toBeTruthy();
  });
});
