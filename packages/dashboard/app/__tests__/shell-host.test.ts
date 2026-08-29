import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetShellHostContextForTests,
  bootstrapShellHostContext,
  detectShellHostContext,
} from "../shell-host";

describe("shell-host", () => {
  beforeEach(() => {
    __resetShellHostContextForTests();
    window.history.replaceState({}, "", "/");
    delete (window as Window & { fusionAPI?: unknown }).fusionAPI;
    delete (window as Window & Record<string, unknown>).__FUSION_SHELL_HOST_CONTEXT__;
  });

  it("falls back to browser when no shell signals are present", () => {
    expect(detectShellHostContext()).toEqual({ kind: "browser" });
  });

  it("detects desktop shell via fusionAPI fallback", () => {
    (window as Window & { fusionAPI?: unknown }).fusionAPI = {};
    expect(detectShellHostContext()).toEqual({ kind: "desktop-shell" });
  });

  it("normalizes explicit global handoff", () => {
    (window as Window & Record<string, unknown>).__FUSION_SHELL_HOST_CONTEXT__ = {
      kind: "mobile-shell",
      mode: "remote",
      connectionId: "conn-1",
      serverUrl: "https://fusion.example.com/",
      canOpenConnectionManager: true,
    };

    expect(detectShellHostContext()).toEqual({
      kind: "mobile-shell",
      mode: "remote",
      connectionId: "conn-1",
      serverUrl: "https://fusion.example.com",
      canOpenConnectionManager: true,
    });
  });

  it("maps FN-3406 legacy query params into canonical contract", () => {
    window.history.replaceState({}, "", "/?shellKind=desktop&shellMode=remote&profileId=p1&serverBaseUrl=https%3A%2F%2Fremote.example.com%2F&shellCanOpenConnectionManager=1");

    expect(detectShellHostContext()).toEqual({
      kind: "desktop-shell",
      mode: "remote",
      connectionId: "p1",
      serverUrl: "https://remote.example.com",
      canOpenConnectionManager: true,
    });
  });

  it("handles malformed handoff values without crashing", () => {
    window.history.replaceState({}, "", "/?shellKind=mobile&shellMode=invalid&serverBaseUrl=notaurl");
    expect(detectShellHostContext()).toEqual({ kind: "mobile-shell" });
  });

  it("strips shell launch params from URL at bootstrap", () => {
    window.history.replaceState({}, "", "/dashboard?view=board&shellKind=desktop&shellMode=remote&profileId=p1#section");
    bootstrapShellHostContext();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/dashboard?view=board#section");
  });
});
