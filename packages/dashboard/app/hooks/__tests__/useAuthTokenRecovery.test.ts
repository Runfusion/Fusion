import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  AUTH_TOKEN_RECOVERY_REQUIRED_EVENT,
  clearAuthToken,
  hasDaemonAuthFailure,
  installAuthFetch,
  setAuthToken,
} from "../../auth";
import { useAuthTokenRecovery } from "../useAuthTokenRecovery";

const originalFetch = window.fetch;

function waitForDaemonAuthRecoveryEvent(): Promise<void> {
  return new Promise((resolve) => {
    const handleRecovery = () => {
      window.removeEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleRecovery);
      resolve();
    };
    window.addEventListener(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, handleRecovery);
  });
}

describe("useAuthTokenRecovery", () => {
  beforeEach(() => {
    clearAuthToken();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    window.fetch = originalFetch;
    delete (window as Window & { __fnAuthFetchInstalled?: boolean }).__fnAuthFetchInstalled;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("opens on daemon auth-failure events and stays open for duplicate signals", () => {
    const { result } = renderHook(() => useAuthTokenRecovery());

    expect(result.current.open).toBe(false);

    act(() => {
      window.dispatchEvent(new Event(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
    });

    expect(result.current.open).toBe(true);

    act(() => {
      window.dispatchEvent(new Event(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
      window.dispatchEvent(new Event(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
    });

    expect(result.current.open).toBe(true);
  });
  it("opens when a daemon-auth 401 latched before the hook mounts", async () => {
    window.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: "Unauthorized", message: "Valid bearer token required" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )) as unknown as typeof window.fetch;
    installAuthFetch();

    const recoveryEvent = waitForDaemonAuthRecoveryEvent();
    await fetch("/api/tasks");
    await recoveryEvent;

    expect(hasDaemonAuthFailure()).toBe(true);
    const { result } = renderHook(() => useAuthTokenRecovery());
    expect(result.current.open).toBe(true);
  });

  it("does not open for a successful API response with a valid token", async () => {
    setAuthToken("valid-token");
    window.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof window.fetch;
    installAuthFetch();

    await fetch("/api/tasks");

    expect(hasDaemonAuthFailure()).toBe(false);
    const { result } = renderHook(() => useAuthTokenRecovery());
    expect(result.current.open).toBe(false);
  });

  it("removes the daemon auth-failure listener on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useAuthTokenRecovery());

    const addedCall = addSpy.mock.calls.find(
      ([type]) => type === AUTH_TOKEN_RECOVERY_REQUIRED_EVENT,
    );
    expect(addedCall).toBeTruthy();
    const addedHandler = addedCall![1] as EventListener;

    unmount();

    expect(removeSpy).toHaveBeenCalledWith(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT, addedHandler);
  });
});
