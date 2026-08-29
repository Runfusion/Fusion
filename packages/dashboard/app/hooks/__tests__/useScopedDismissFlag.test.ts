import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
}));

import { getScopedItem, setScopedItem } from "../../utils/projectStorage";
import { useScopedDismissFlag } from "../useScopedDismissFlag";

describe("useScopedDismissFlag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds dismissed from scoped storage on mount", () => {
    vi.mocked(getScopedItem).mockReturnValue("true");
    const { result } = renderHook(() => useScopedDismissFlag("key", "p1"));

    expect(result.current.dismissed).toBe(true);
  });

  it("dismiss writes scoped storage and flips the flag", () => {
    vi.mocked(getScopedItem).mockReturnValue(null);
    const { result } = renderHook(() => useScopedDismissFlag("key", "p1"));

    act(() => {
      result.current.dismiss();
    });

    expect(setScopedItem).toHaveBeenCalledWith("key", "true", "p1");
    expect(result.current.dismissed).toBe(true);
  });

  it("re-reads the scoped value when the project changes (no cross-project leak)", () => {
    vi.mocked(getScopedItem).mockReturnValue(null);
    const { rerender } = renderHook(
      (props: { id: string | undefined }) => useScopedDismissFlag("key", props.id),
      { initialProps: { id: "p1" } },
    );

    rerender({ id: "p2" });

    // The project-change re-read must consult scoped storage for the new project.
    expect(getScopedItem).toHaveBeenCalledWith("key", "p2");
  });
});
