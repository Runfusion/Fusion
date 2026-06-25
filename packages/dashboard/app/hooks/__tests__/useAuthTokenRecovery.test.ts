import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { AUTH_TOKEN_RECOVERY_REQUIRED_EVENT } from "../../auth";
import { useAuthTokenRecovery } from "../useAuthTokenRecovery";

describe("useAuthTokenRecovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("opens when the daemon auth-failure event fires", () => {
    const { result } = renderHook(() => useAuthTokenRecovery());

    expect(result.current.open).toBe(false);

    act(() => {
      window.dispatchEvent(new Event(AUTH_TOKEN_RECOVERY_REQUIRED_EVENT));
    });

    expect(result.current.open).toBe(true);
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
