import type { ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { useViewSidebarWidth } from "../useViewSidebarWidth";

function wrapper({ children }: { children: ReactNode }) {
  return <ViewLayoutProvider projectId="project-hook">{children}</ViewLayoutProvider>;
}

describe("useViewSidebarWidth", () => {
  it("offre un défaut isolé sans provider", () => {
    const { result } = renderHook(() => useViewSidebarWidth());
    expect(result.current.width).toBe(300);
    act(() => { result.current.commitWidth(360); });
    expect(result.current.width).toBe(360);
    expect(localStorage.getItem("kb-dashboard-view-sidebar-width")).toBeNull();
  });

  it("contraint un host sans réécrire la préférence partagée", () => {
    const { result, rerender } = renderHook(
      ({ max }: { max?: number }) => useViewSidebarWidth({ hostMaxWidth: max }),
      { wrapper, initialProps: { max: undefined } },
    );
    act(() => { result.current.commitWidth(500); });
    expect(result.current.preferredWidth).toBe(500);
    rerender({ max: 320 });
    expect(result.current.width).toBe(320);
    expect(result.current.preferredWidth).toBe(500);
    rerender({ max: undefined });
    expect(result.current.width).toBe(500);
  });
});
