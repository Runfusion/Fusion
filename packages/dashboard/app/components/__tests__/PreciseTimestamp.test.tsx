import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreciseTimestamp } from "../PreciseTimestamp";

const localIso = (year: number, month: number, day: number, hours: number, minutes: number, seconds: number, milliseconds: number): string => (
  new Date(year, month - 1, day, hours, minutes, seconds, milliseconds).toISOString()
);

const now = new Date(2026, 5, 17, 16, 40, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PreciseTimestamp", () => {
  it("renders a precise same-day clock reading", () => {
    render(<PreciseTimestamp timestamp={localIso(2026, 6, 17, 14, 32, 7, 482)} testId="timestamp" />);

    expect(screen.getByTestId("timestamp")).toHaveTextContent("14:32:07.482");
  });

  it("renders a dated form for a different local day", () => {
    render(<PreciseTimestamp timestamp={localIso(2026, 6, 16, 14, 32, 7, 482)} testId="timestamp" />);

    expect(screen.getByTestId("timestamp")).toHaveTextContent("2026-06-16 14:32:07.482");
  });

  it("preserves the raw ISO value and exposes the full local time on hover", () => {
    const timestamp = localIso(2026, 6, 17, 14, 32, 7, 482);
    render(<PreciseTimestamp timestamp={timestamp} testId="timestamp" />);

    expect(screen.getByTestId("timestamp")).toHaveAttribute("datetime", timestamp);
    expect(screen.getByTestId("timestamp")).toHaveAttribute("title", "2026-06-17 14:32:07.482");
  });

  it.each([undefined, "", "not-a-date"])("renders no shell for %p", (timestamp) => {
    const { container } = render(<PreciseTimestamp timestamp={timestamp} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("merges an additional class without replacing its shared class", () => {
    render(<PreciseTimestamp timestamp={localIso(2026, 6, 17, 14, 32, 7, 482)} className="surface-timestamp" testId="timestamp" />);

    expect(screen.getByTestId("timestamp")).toHaveClass("precise-timestamp", "surface-timestamp");
  });
});
