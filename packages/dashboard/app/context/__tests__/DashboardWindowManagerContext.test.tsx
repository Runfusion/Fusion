import { useEffect, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DashboardWindowManagerProvider,
  DashboardWindowManagerScope,
  resolveDashboardWindowBounds,
  useDashboardWindowFocusRestoring,
  useDashboardWindowSurface,
  useDashboardWindowVisibility,
} from "../DashboardWindowManagerContext";

/*
FNXC:DashboardWindowBounds 2026-09-14-10:52:
Each shell edge falls back independently. Invalid or absent landmark measurements must not poison valid peers or reintroduce an artificial gutter.
*/
/*
FNXC:DashboardWindowVisibility 2026-09-14-17:46:
FN-392: the restoration fence is the contract that keeps hide/show order-neutral. It must be open while surfaces are
revealed and their focus effects re-run, and closed again afterwards — including when nothing focusable survives — so a
later real interaction is never silently suppressed. Scope changes abandon a pending restoration rather than leaking it.
*/
interface FenceProbeProps {
  focusable: boolean;
  /** Records the fence state observed by the surface's own visibility effect, exactly as a window would read it. */
  onVisibilityCommit: (state: { globallyHidden: boolean; restoring: boolean }) => void;
  onReady: (isRestoring: () => boolean) => void;
}

function FenceProbe({ focusable, onVisibilityCommit, onReady }: FenceProbeProps) {
  const surface = useDashboardWindowSurface({ logicalId: "fenced", locallyVisible: true, stackOrder: 1 });
  const isRestoring = useDashboardWindowFocusRestoring();
  const visibility = useDashboardWindowVisibility();
  const commitRef = useRef(onVisibilityCommit);
  commitRef.current = onVisibilityCommit;
  useEffect(() => {
    onReady(isRestoring);
  }, [isRestoring, onReady]);
  useEffect(() => {
    commitRef.current({ globallyHidden: surface.globallyHidden, restoring: isRestoring() });
  }, [isRestoring, surface.globallyHidden]);
  return (
    <div>
      <div
        ref={surface.rootRef}
        data-testid="fenced-surface"
        aria-hidden={surface.globallyHidden || undefined}
        inert={surface.globallyHidden || undefined}
      >
        {focusable ? <button type="button">inside</button> : null}
      </div>
      <button type="button" onClick={() => visibility?.toggleVisibility()}>toggle</button>
    </div>
  );
}

describe("dashboard window restoration fence", () => {
  it.each([
    ["with a focusable surface", true],
    ["with nothing focusable left", false],
  ])("opens across the reveal and closes after the focus attempt %s", async (_name, focusable) => {
    const commits: Array<{ globallyHidden: boolean; restoring: boolean }> = [];
    const readFence = vi.fn<() => boolean>();
    render(
      <DashboardWindowManagerProvider>
        <DashboardWindowManagerScope scopeKey="project-a" />
        <FenceProbe
          focusable={focusable}
          onVisibilityCommit={(state) => commits.push(state)}
          onReady={(isRestoring) => readFence.mockImplementation(isRestoring)}
        />
      </DashboardWindowManagerProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    await waitFor(() => expect(screen.getByTestId("fenced-surface")).toHaveAttribute("inert"));

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    await waitFor(() => expect(screen.getByTestId("fenced-surface")).not.toHaveAttribute("inert"));

    // The revealing commit runs inside the fence, so a surface re-running its focus effect cannot claim a layer.
    expect(commits.at(-1)).toEqual({ globallyHidden: false, restoring: true });
    expect(commits.some((commit) => commit.globallyHidden)).toBe(true);

    // The fence closes once the focus attempt settles, whether or not anything focusable survived.
    await waitFor(() => expect(readFence()).toBe(false));
  });

  it("abandons a pending restoration when the project scope changes", async () => {
    const readFence = vi.fn<() => boolean>();
    const probe = (scope: string) => (
      <DashboardWindowManagerProvider>
        <DashboardWindowManagerScope scopeKey={scope} />
        <FenceProbe focusable onVisibilityCommit={() => undefined} onReady={(isRestoring) => readFence.mockImplementation(isRestoring)} />
      </DashboardWindowManagerProvider>
    );
    const { rerender } = render(probe("project-a"));

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    await waitFor(() => expect(screen.getByTestId("fenced-surface")).toHaveAttribute("inert"));

    rerender(probe("project-b"));

    await waitFor(() => expect(screen.getByTestId("fenced-surface")).not.toHaveAttribute("inert"));
    expect(readFence()).toBe(false);
  });

  it("reports no restoration outside a provider", () => {
    function Standalone() {
      return <output data-testid="standalone">{String(useDashboardWindowFocusRestoring()())}</output>;
    }
    render(<Standalone />);
    expect(screen.getByTestId("standalone")).toHaveTextContent("false");
  });
});

describe("resolveDashboardWindowBounds", () => {
  it("uses exact shell coordinates", () => {
    expect(resolveDashboardWindowBounds({
      viewportWidth: 1280,
      viewportHeight: 800,
      headerRect: { bottom: 64 },
      footerRect: { top: 764 },
      rightDockRect: { left: 980 },
    })).toEqual({ left: 0, top: 64, right: 980, bottom: 764, width: 980, height: 700 });
  });

  it("falls back invalid and absent edges independently to the viewport", () => {
    expect(resolveDashboardWindowBounds({
      viewportWidth: 1280,
      viewportHeight: 800,
      headerRect: { bottom: Number.NaN },
      footerRect: null,
      rightDockRect: { left: Number.POSITIVE_INFINITY },
    })).toEqual({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
  });

  it("collapses safely when chrome consumes the available height", () => {
    expect(resolveDashboardWindowBounds({
      viewportWidth: 320,
      viewportHeight: 240,
      headerRect: { bottom: 200 },
      footerRect: { top: 100 },
      rightDockRect: { left: -100 },
    })).toEqual({ left: 0, top: 200, right: 0, bottom: 200, width: 0, height: 0 });
  });
});
