import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

import { getScopedItem, removeScopedItem, setScopedItem } from "../../utils/projectStorage";
import { useCapacityRiskBanner } from "../useCapacityRiskBanner";

const base = {
  agentStats: { todoTaskCount: 5, idleNonEphemeralCount: 0 },
  inProgressCount: 1,
  inReviewCount: 0,
  capacityRiskBannerEnabled: true,
  capacityRiskTodoThreshold: 3,
  settingsLoaded: true,
  currentProjectId: "p1",
};

describe("useCapacityRiskBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes the capacity-risk signal from counts + threshold", () => {
    const { result } = renderHook(() => useCapacityRiskBanner(base));

    expect(result.current.signal).toBeTruthy();
    expect(result.current.signal.atRisk).toBe(true);
    expect(result.current.signal.threshold).toBe(3);
  });

  it("dismiss persists to scoped storage and hides", () => {
    const { result } = renderHook(() => useCapacityRiskBanner(base));

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.dismissed).toBe(true);
    expect(setScopedItem).toHaveBeenCalledWith(expect.any(String), "true", "p1");
  });

  it("clears a prior dismissal when the banner is re-enabled after hydrate", () => {
    vi.mocked(getScopedItem).mockReturnValue("true");
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useCapacityRiskBanner({ ...base, capacityRiskBannerEnabled: props.enabled }),
      { initialProps: { enabled: false } },
    );

    // First settings load hydrates without clearing.
    expect(result.current.dismissed).toBe(true);
    expect(removeScopedItem).not.toHaveBeenCalled();

    // Re-enabling the banner resurrects the dismissed banner.
    rerender({ enabled: true });

    expect(removeScopedItem).toHaveBeenCalledWith(expect.any(String), "p1");
    expect(result.current.dismissed).toBe(false);
  });
  it("clears a prior dismissal when the todo threshold changes after hydrate", () => {
    vi.mocked(getScopedItem).mockReturnValue("true");
    const { result, rerender } = renderHook(
      (props: { threshold: number }) =>
        useCapacityRiskBanner({ ...base, capacityRiskTodoThreshold: props.threshold }),
      { initialProps: { threshold: 3 } },
    );

    // First settings load hydrates without clearing.
    expect(result.current.dismissed).toBe(true);
    expect(removeScopedItem).not.toHaveBeenCalled();

    // Changing the threshold resurrects the previously-dismissed banner.
    rerender({ threshold: 5 });

    expect(removeScopedItem).toHaveBeenCalledWith(expect.any(String), "p1");
    expect(result.current.dismissed).toBe(false);
  });
});
