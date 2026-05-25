import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as reportsHook from "../useReports.js";
import { ReportsView } from "../ReportsView.js";

// ReportDetailPanel transitively calls useReportPreview → fetch(), and jsdom
// has no fetch. The rejection lands after teardown and React's state update
// then references `window`, surfacing as an unhandled error that fails the
// suite. Stub the preview API to resolve synchronously.
vi.mock("../api.js", () => ({
  listReports: vi.fn().mockResolvedValue([]),
  getReport: vi.fn().mockResolvedValue(null),
  getReportPreviewHtml: vi.fn().mockResolvedValue(""),
  getReportExportUrl: vi.fn().mockReturnValue(""),
  approveReport: vi.fn().mockResolvedValue(null),
  rejectReport: vi.fn().mockResolvedValue(null),
  publishReport: vi.fn().mockResolvedValue(null),
  getShareBlocks: vi.fn().mockResolvedValue({}),
}));

describe("ReportsView", () => {
  it("renders list and compare toggle", () => {
    vi.spyOn(reportsHook, "useReports").mockReturnValue({
      filters: { cadence: "all", status: "all", from: "", to: "", q: "", agentId: "" },
      setFilters: vi.fn(),
      reports: [{ id: "R-1", title: "A", cadence: "daily", status: "published", periodStart: "2026-01-01", periodEnd: "2026-01-02", metadata: {} }],
      loading: false,
      selectedId: "R-1",
      selectedReport: { id: "R-1", title: "A", cadence: "daily", status: "published", periodStart: "2026-01-01", periodEnd: "2026-01-02", metadata: {} },
      selectId: vi.fn(),
      compareMode: false,
      compareA: undefined,
      compareB: undefined,
      enterCompareMode: vi.fn(),
      closeCompareMode: vi.fn(),
      setCompareSlot: vi.fn(),
    } as never);
    const { getByText } = render(<ReportsView addToast={vi.fn()} />);
    fireEvent.click(getByText("Compare"));
    expect(getByText("Reports")).toBeInTheDocument();
  });
});
