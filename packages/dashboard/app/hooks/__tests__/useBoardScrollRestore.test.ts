import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { TaskView } from "../useViewState";

vi.mock("../../utils/boardScrollSnapshot", () => ({
  captureBoardScrollSnapshot: vi.fn(),
  restoreBoardScrollSnapshot: vi.fn(() => true),
}));

import { captureBoardScrollSnapshot, restoreBoardScrollSnapshot } from "../../utils/boardScrollSnapshot";
import { useBoardScrollRestore } from "../useBoardScrollRestore";

const mockedCapture = vi.mocked(captureBoardScrollSnapshot);
const mockedRestore = vi.mocked(restoreBoardScrollSnapshot);

describe("useBoardScrollRestore", () => {
  beforeEach(() => {
    mockedCapture.mockReset();
    mockedRestore.mockReset();
    mockedRestore.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes capture and requestRestore without throwing", () => {
    const { result } = renderHook(() => useBoardScrollRestore("board"));

    expect(typeof result.current.capture).toBe("function");
    expect(typeof result.current.requestRestore).toBe("function");
    expect(() => result.current.capture()).not.toThrow();
    expect(() => result.current.requestRestore()).not.toThrow();
  });

  it("restores the captured snapshot after returning to the board view", () => {
    const sentinel = { boardLeft: 42, boardTop: 7, columnTops: { c1: 3 } };
    mockedCapture.mockReturnValue(sentinel);

    // Make the double requestAnimationFrame fire synchronously so the restore
    // lands inside the act() that commits the board-view effect.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    const { result, rerender } = renderHook(
      ({ taskView }: { taskView: TaskView }) => useBoardScrollRestore(taskView),
      { initialProps: { taskView: "task-detail" } },
    );

    // Off the board with nothing pending → no restore yet.
    expect(mockedRestore).not.toHaveBeenCalled();

    act(() => {
      result.current.capture();
      result.current.requestRestore();
    });

    // Restore waits for the view to return to "board".
    expect(mockedRestore).not.toHaveBeenCalled();

    act(() => {
      rerender({ taskView: "board" });
    });

    expect(mockedRestore).toHaveBeenCalledTimes(1);
    expect(mockedRestore).toHaveBeenCalledWith(sentinel);
  });
});
