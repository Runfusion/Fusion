import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  LIVE_TIME_INDICATOR_POLL_MS,
  isLiveTimeTickerRunning,
  liveTimeTickerSubscriberCount,
  useLiveTimeTicker,
} from "../../hooks/useLiveTimeTicker";

/*
FNXC:BoardPerformance 2026-07-26-09:55:
Regression coverage for the mobile tab-discard fix: every rendered TaskCard used to own a 30s
`setInterval`, so a full board kept a backgrounded tab busy and iOS Safari / iOS PWA / Chrome Android
discarded the page (white-splash reload on return). The invariant asserted here is the shared
ticker's contract, not one card's behavior:
  1. N subscribers => exactly ONE interval.
  2. No ticks while `document.visibilityState === "hidden"`.
  3. An immediate tick on hidden -> visible, so indicators are never stale on return.
  4. Zero subscribers => no interval at all.
The subscriber is a minimal component calling `useLiveTimeTicker`, exercising the same seam TaskCard
uses; rendering real TaskCards would only add cost, not signal, since the timer no longer lives there.
*/

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Stand-in for a TaskCard that qualifies for a live elapsed-time indicator. */
function TickerCard({ enabled = true }: { enabled?: boolean }) {
  const nowMs = useLiveTimeTicker(enabled);
  return <div data-testid="card">{nowMs}</div>;
}

let setIntervalSpy: ReturnType<typeof vi.spyOn>;
let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.useFakeTimers();
  setIntervalSpy = vi.spyOn(window, "setInterval");
  clearIntervalSpy = vi.spyOn(window, "clearInterval");
});

afterEach(() => {
  cleanup();
  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("shared live-time ticker", () => {
  it("creates ONE interval for N mounted cards, not N", () => {
    const view = render(
      <>
        <TickerCard />
        <TickerCard />
        <TickerCard />
        <TickerCard />
        <TickerCard />
      </>,
    );

    expect(liveTimeTickerSubscriberCount()).toBe(5);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), LIVE_TIME_INDICATOR_POLL_MS);
    expect(isLiveTimeTickerRunning()).toBe(true);

    view.unmount();
  });

  it("does not subscribe cards that opt out of the live indicator", () => {
    const view = render(
      <>
        <TickerCard enabled={false} />
        <TickerCard enabled={false} />
      </>,
    );

    expect(liveTimeTickerSubscriberCount()).toBe(0);
    expect(isLiveTimeTickerRunning()).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    view.unmount();
  });

  it("stops ticking while the tab is hidden and ticks immediately on becoming visible", () => {
    const view = render(<TickerCard />);
    const card = view.getByTestId("card");
    const initial = card.textContent;

    // Visible: the ticker advances on cadence.
    act(() => {
      vi.advanceTimersByTime(LIVE_TIME_INDICATOR_POLL_MS);
    });
    const afterVisibleTick = card.textContent;
    expect(afterVisibleTick).not.toBe(initial);

    // Hidden: the interval is torn down, and no amount of elapsed time ticks.
    act(() => {
      setVisibility("hidden");
    });
    expect(isLiveTimeTickerRunning()).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(LIVE_TIME_INDICATOR_POLL_MS * 10);
    });
    expect(card.textContent).toBe(afterVisibleTick);

    // Visible again: tick IMMEDIATELY, without waiting a full period.
    act(() => {
      setVisibility("visible");
    });
    expect(card.textContent).not.toBe(afterVisibleTick);
    expect(isLiveTimeTickerRunning()).toBe(true);

    view.unmount();
  });

  it("clears the interval when the last subscriber unmounts", () => {
    const view = render(
      <>
        <TickerCard />
        <TickerCard />
      </>,
    );
    expect(isLiveTimeTickerRunning()).toBe(true);

    view.rerender(<TickerCard />);
    expect(liveTimeTickerSubscriberCount()).toBe(1);
    expect(isLiveTimeTickerRunning()).toBe(true);

    view.unmount();
    expect(liveTimeTickerSubscriberCount()).toBe(0);
    expect(isLiveTimeTickerRunning()).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
