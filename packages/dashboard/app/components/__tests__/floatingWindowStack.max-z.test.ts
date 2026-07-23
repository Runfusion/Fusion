import { afterEach, describe, expect, it, vi } from "vitest";

/*
FNXC:PluginOverlayLayering 2026-07-23-01:21:
The plugin overlay ceiling must exist before any floating window is claimed, remain at its boot
floor while dashboard layers are lower, and follow the session-monotonic utility stack once that
stack exceeds the floor. Module evaluation must remain safe in non-DOM runtimes.
*/

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--fusion-max-z");
});

describe("floatingWindowStack --fusion-max-z synchronization", () => {
  it("publishes the boot floor when the module loads", async () => {
    vi.resetModules();

    await import("../floatingWindowStack");

    expect(document.documentElement.style.getPropertyValue("--fusion-max-z")).toBe("11001");
  });

  it("keeps the floor until the utility stack exceeds it, then follows every claim", async () => {
    vi.resetModules();
    const { FUSION_MAX_Z_FLOOR, currentFloatingZ, nextFloatingZ } = await import("../floatingWindowStack");

    for (let claim = currentFloatingZ(); claim < FUSION_MAX_Z_FLOOR; claim += 1) {
      nextFloatingZ();
    }
    expect(currentFloatingZ()).toBe(FUSION_MAX_Z_FLOOR);
    expect(document.documentElement.style.getPropertyValue("--fusion-max-z")).toBe(String(FUSION_MAX_Z_FLOOR));

    nextFloatingZ();
    expect(document.documentElement.style.getPropertyValue("--fusion-max-z")).toBe(String(currentFloatingZ()));

    nextFloatingZ();
    expect(document.documentElement.style.getPropertyValue("--fusion-max-z")).toBe(String(currentFloatingZ()));
  });

  it("loads without writing when document is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("document", undefined);

    await expect(import("../floatingWindowStack")).resolves.toBeDefined();
  });
});
