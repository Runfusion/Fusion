import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGraphPositions } from "../hooks/useGraphPositions";
import * as storage from "../utils/graphPositionStorage";

vi.mock("../utils/graphPositionStorage", () => ({
  loadPositions: vi.fn(),
  savePositions: vi.fn(),
  clearPositions: vi.fn(),
}));

describe("useGraphPositions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads saved positions on mount with project scope", () => {
    vi.mocked(storage.loadPositions).mockReturnValue({ a: { x: 1, y: 2 } });

    const { result } = renderHook(() => useGraphPositions({ projectId: "p1", visibleTaskIds: new Set(["a"]) }));

    expect(storage.loadPositions).toHaveBeenCalledWith("p1");
    expect(result.current.savedPositions).toEqual({ a: { x: 1, y: 2 } });
  });

  it("reloads positions when project id changes", () => {
    vi.mocked(storage.loadPositions).mockReturnValueOnce({ a: { x: 1, y: 1 } }).mockReturnValueOnce({ b: { x: 2, y: 2 } });

    const { result, rerender } = renderHook(
      ({ projectId }) => useGraphPositions({ projectId, visibleTaskIds: new Set(["a", "b"]) }),
      { initialProps: { projectId: "p1" } },
    );

    rerender({ projectId: "p2" });

    expect(storage.loadPositions).toHaveBeenNthCalledWith(1, "p1");
    expect(storage.loadPositions).toHaveBeenNthCalledWith(2, "p2");
    expect(result.current.savedPositions).toEqual({ b: { x: 2, y: 2 } });
  });

  it("persistPositions writes scoped and filters non-visible ids", () => {
    vi.mocked(storage.loadPositions).mockReturnValue({});

    const { result } = renderHook(() => useGraphPositions({ projectId: "p1", visibleTaskIds: new Set(["a"]) }));

    act(() => {
      result.current.persistPositions({ a: { x: 1, y: 2 }, hidden: { x: 9, y: 9 } });
    });

    expect(storage.savePositions).toHaveBeenCalledWith({ a: { x: 1, y: 2 }, hidden: { x: 9, y: 9 } }, new Set(["a"]), "p1");
    expect(result.current.savedPositions).toEqual({ a: { x: 1, y: 2 } });
  });

  it("clearSavedPositions clears storage and resets state", () => {
    vi.mocked(storage.loadPositions).mockReturnValue({ a: { x: 1, y: 2 } });

    const { result } = renderHook(() => useGraphPositions({ projectId: "p1", visibleTaskIds: new Set(["a"]) }));

    act(() => {
      result.current.clearSavedPositions();
    });

    expect(storage.clearPositions).toHaveBeenCalledWith("p1");
    expect(result.current.savedPositions).toBeNull();
  });
});
