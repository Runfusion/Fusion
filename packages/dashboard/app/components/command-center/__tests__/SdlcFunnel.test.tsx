import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock the api() helper so the funnel fetches a deterministic fixture.
const apiMock = vi.fn();
vi.mock("../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
}));

import { SdlcFunnel } from "../SdlcFunnel";
import type { DateRange } from "../DateRangePicker";

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };

/** Build an /activity payload whose funnel sub-shape drives the component. */
function activityFixture(funnel: Record<string, unknown>) {
  return {
    from: "2026-06-08",
    to: null,
    sessions: 0,
    messages: 0,
    activeNodes: 0,
    activeAgents: 0,
    daily: [],
    stickiness: 0,
    mttr: { value: null, unavailable: true },
    funnel,
  };
}

function fullFunnel() {
  return {
    from: "2026-06-08",
    to: null,
    stages: [
      { stage: "triage", entered: 4, conversionFromPrev: null },
      { stage: "todo", entered: 4, conversionFromPrev: 1 },
      { stage: "in-progress", entered: 3, conversionFromPrev: 0.75 },
      { stage: "in-review", entered: 2, conversionFromPrev: 0.666 },
      { stage: "done", entered: 2, conversionFromPrev: 1 },
      { stage: "other", entered: 1, conversionFromPrev: null },
    ],
    enteredInRange: 4,
    doneInRange: 2,
    completionRate: 0.5,
    rangeDays: 7,
    throughputPerDay: 2 / 7,
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

describe("SdlcFunnel", () => {
  it("fetches the activity endpoint and renders per-stage counts", async () => {
    apiMock.mockResolvedValue(activityFixture(fullFunnel()));
    render(<SdlcFunnel range={range7d} />);

    await screen.findByTestId("cc-area-funnel");
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("/command-center/activity"), undefined);

    // Funnel bars carry an accessible label per stage with its count.
    expect(screen.getByLabelText("Triage: 4")).toBeTruthy();
    expect(screen.getByLabelText("In progress: 3")).toBeTruthy();
    expect(screen.getByLabelText("Done: 2")).toBeTruthy();
    // Unknown-trait columns surface under "Other".
    expect(screen.getByLabelText("Other: 1")).toBeTruthy();
  });

  it("shows completion rate and throughput stat cards", async () => {
    apiMock.mockResolvedValue(activityFixture(fullFunnel()));
    render(<SdlcFunnel range={range7d} />);

    await screen.findByTestId("cc-area-funnel");
    expect(screen.getByRole("img", { name: "Completion rate for in-range triage entrants" })).toBeTruthy();
    expect(screen.getByTestId("cc-funnel-completion-rate").textContent).toContain("50%");
    expect(screen.getByTestId("cc-funnel-done").textContent).toContain("2");
    expect(screen.getByTestId("cc-funnel-entered").textContent).toContain("4");
    expect(screen.getByTestId("cc-funnel-throughput").textContent).toContain("0.29");
  });

  it("renders '—' for a null completion rate (zero-denominator)", async () => {
    apiMock.mockResolvedValue(
      activityFixture({
        from: "2026-06-08",
        to: null,
        stages: [
          { stage: "triage", entered: 0, conversionFromPrev: null },
          { stage: "todo", entered: 0, conversionFromPrev: null },
          { stage: "in-progress", entered: 0, conversionFromPrev: null },
          { stage: "in-review", entered: 1, conversionFromPrev: null },
          { stage: "done", entered: 1, conversionFromPrev: null },
        ],
        enteredInRange: 0,
        doneInRange: 1,
        completionRate: null,
        rangeDays: 7,
        throughputPerDay: 1 / 7,
      }),
    );
    render(<SdlcFunnel range={range7d} />);

    await screen.findByTestId("cc-area-funnel");
    expect(screen.getByRole("img", { name: "Completion rate for in-range triage entrants" })).toBeTruthy();
    expect(screen.getByTestId("cc-funnel-completion-rate").textContent).toContain("—");
  });

  it("renders the empty state when no transitions exist in the range", async () => {
    apiMock.mockResolvedValue(
      activityFixture({
        from: "2026-06-08",
        to: null,
        stages: [
          { stage: "triage", entered: 0, conversionFromPrev: null },
          { stage: "todo", entered: 0, conversionFromPrev: null },
          { stage: "in-progress", entered: 0, conversionFromPrev: null },
          { stage: "in-review", entered: 0, conversionFromPrev: null },
          { stage: "done", entered: 0, conversionFromPrev: null },
        ],
        enteredInRange: 0,
        doneInRange: 0,
        completionRate: null,
        rangeDays: 7,
        throughputPerDay: 0,
      }),
    );
    render(<SdlcFunnel range={range7d} />);

    await waitFor(() => {
      expect(screen.getByTestId("cc-area-funnel-empty")).toBeTruthy();
    });
  });
});
