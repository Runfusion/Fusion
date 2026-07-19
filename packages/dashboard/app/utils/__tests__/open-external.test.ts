import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../open-external";

/*
FNXC:DesktopOAuth 2026-07-18-04:00:
OAuth window.open after the /auth/login await can outlive Chromium's transient
user activation and get silently popup-blocked on desktop (observed with the
OpenAI Codex flow). The helper must prefer the activation-free desktop IPC
bridge and only fall back to window.open on the web (or when the bridge
declines the URL).
*/
describe("openExternalUrl", () => {
  const w = window as unknown as { fusionAPI?: { openExternal?: (url: string) => Promise<boolean> } };

  afterEach(() => {
    delete w.fusionAPI;
    vi.restoreAllMocks();
  });

  it("prefers the desktop openExternal bridge over window.open", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    w.fusionAPI = { openExternal };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    openExternalUrl("https://auth.openai.com/oauth/authorize?x=1");
    await Promise.resolve();

    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?x=1");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  /*
  FNXC:DesktopOAuth 2026-07-18-06:00:
  Review finding: a window.open fallback from the async continuation runs
  without user activation and is always popup-blocked — the desktop path must
  NOT pretend it helps. A declined/failed bridge is logged, never window.open'd.
  */
  it("does not window.open from the async continuation when the bridge declines", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    w.fusionAPI = { openExternal };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    openExternalUrl("https://example.com/auth");
    await Promise.resolve();
    await Promise.resolve();

    expect(windowOpen).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("uses window.open when no desktop bridge exists", () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    openExternalUrl("https://example.com/auth");

    expect(windowOpen).toHaveBeenCalledWith("https://example.com/auth", "_blank");
  });
});
