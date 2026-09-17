import { cleanup, render, screen } from "@testing-library/react";
import { act, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DashboardWindowManagerProvider,
  resolveBottomDockReservation,
  useDashboardWindowBottomDockReservation,
  useDashboardWindowBottomDockReservationControl,
  useDashboardWindowManager,
  useDashboardWindowSurface,
} from "../DashboardWindowManagerContext";

/*
FNXC:FloatingWindowSnap 2026-09-17-04:51:
FN-487 acceptance for the shared reservation registry: several docked windows occupy the SAME full-width band, so the
aggregate is a maximum and never a sum; an unmounted surface or a project scope change must leave no phantom band.
*/

function Reader() {
  const reserved = useDashboardWindowBottomDockReservation();
  return <output data-testid="reservation">{reserved}</output>;
}

/** A minimal producer: it registers a real surface token, then publishes through the control hook. */
function Producer({ id, px }: { id: string; px: number | null }) {
  const surface = useDashboardWindowSurface({ logicalId: id });
  const publish = useDashboardWindowBottomDockReservationControl();
  const token = surface.token;
  useEffect(() => {
    publish(token, px);
    return () => publish(token, null);
  }, [publish, px, token]);
  return <div ref={surface.rootRef} data-testid={`producer-${id}`} />;
}

function ScopeControl() {
  const manager = useDashboardWindowManager();
  return (
    <button type="button" data-testid="reset-scope" onClick={() => manager?.resetScope("autre-projet")}>
      reset
    </button>
  );
}

function reservation(): number {
  return Number(screen.getByTestId("reservation").textContent);
}

afterEach(cleanup);

describe("bottom dock reservation registry", () => {
  /* (j) The pure helper never sums, never returns a negative, and ignores non-finite publications. */
  it("aggregates published heights by maximum and ignores invalid values", () => {
    expect(resolveBottomDockReservation([])).toBe(0);
    expect(resolveBottomDockReservation([200, 320])).toBe(320);
    expect(resolveBottomDockReservation([320, 200])).toBe(320);
    expect(resolveBottomDockReservation([Number.NaN, Number.POSITIVE_INFINITY, -50, 0])).toBe(0);
    expect(resolveBottomDockReservation([-400, 120])).toBe(120);
  });

  /* (h) Two docked windows share one band: 200 + 320 must read 320, never 520. */
  it("publishes the maximum of two concurrently docked windows", () => {
    render(
      <DashboardWindowManagerProvider>
        <Reader />
        <Producer id="w-a" px={200} />
        <Producer id="w-b" px={320} />
      </DashboardWindowManagerProvider>,
    );

    expect(reservation()).toBe(320);
  });

  /* (i) Unmounting the taller window falls back to the remaining one; unmounting all releases the band. */
  it("releases the band when a docked surface unmounts", () => {
    const { rerender } = render(
      <DashboardWindowManagerProvider>
        <Reader />
        <Producer id="w-a" px={200} />
        <Producer id="w-b" px={320} />
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(320);

    rerender(
      <DashboardWindowManagerProvider>
        <Reader />
        <Producer id="w-a" px={200} />
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(200);

    rerender(
      <DashboardWindowManagerProvider>
        <Reader />
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(0);
  });

  /* (i) A project scope change purges every reservation, so a new project never inherits a foreign band. */
  it("purges every reservation when the scope resets", () => {
    render(
      <DashboardWindowManagerProvider>
        <Reader />
        <ScopeControl />
        <Producer id="w-a" px={240} />
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(240);

    act(() => {
      screen.getByTestId("reset-scope").click();
    });
    expect(reservation()).toBe(0);
  });

  /* (j) Releasing with `null` clears the entry, and republishing the same value is a no-op. */
  it("treats null as a release and an unchanged value as a no-op", () => {
    const { rerender } = render(
      <DashboardWindowManagerProvider>
        <Reader />
        <Producer id="w-a" px={300} />
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(300);
    const node = screen.getByTestId("reservation");

    rerender(
      <DashboardWindowManagerProvider>
        <Reader />
        <Producer id="w-a" px={300} />
      </DashboardWindowManagerProvider>,
    );
    // A republication of the same value neither changes the value nor replaces the rendered node.
    expect(reservation()).toBe(300);
    expect(screen.getByTestId("reservation")).toBe(node);

    rerender(
      <DashboardWindowManagerProvider>
        <Reader />
        <Producer id="w-a" px={null} />
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(0);
  });

  /* Outside a provider nothing can be reserved and publishing is a safe no-op. */
  it("is safe outside a provider", () => {
    render(
      <>
        <Reader />
        <Producer id="w-a" px={400} />
      </>,
    );
    expect(reservation()).toBe(0);
  });
});
