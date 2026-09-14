import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as reportsHook from "../useReports.js";
import { ReportsView } from "../ReportsView.js";

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

/*
FNXC:StandardizedViewActions 2026-09-13-20:32:
FN-379 hides header action labels on phone chrome, so an icon-less action would leave a visually empty touch
target. Reports is read-only: its single Compare action must paint a pictogram and keep its accessible name on a
phone, and the destination must still invent no creation entry.
*/
function mockModel(overrides: Record<string, unknown> = {}) {
  vi.spyOn(reportsHook, "useReports").mockReturnValue({
    filters: { cadence: "all", status: "all", from: "", to: "", q: "", agentId: "" },
    setFilters: vi.fn(),
    reports: [],
    loading: false,
    selectedId: undefined,
    selectedReport: undefined,
    selectId: vi.fn(),
    compareMode: false,
    compareA: undefined,
    compareB: undefined,
    enterCompareMode: vi.fn(),
    closeCompareMode: vi.fn(),
    setCompareSlot: vi.fn(),
    ...overrides,
  } as never);
}

describe("Reports standardized view layout", () => {
  afterEach(() => {
    delete document.documentElement.dataset.viewportMode;
    vi.restoreAllMocks();
  });

  it("keeps its phone header action visible as an icon with its accessible name", () => {
    mockModel();
    document.documentElement.dataset.viewportMode = "mobile";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });

    render(<ReportsView addToast={vi.fn()} />);

    const compare = screen.getByTestId("reports-compare-button");
    expect(compare).toHaveClass("view-action-button--mobile-icon-only");
    expect(compare).toHaveAccessibleName("Compare");
    expect(compare.querySelector("svg")).toBeInTheDocument();
    expect(compare.querySelector(".view-action-button__label")?.textContent).toBe("Compare");
  });

  it("paints one canonical header and invents no creation entry for a read-only collection", () => {
    mockModel();
    render(<ReportsView addToast={vi.fn()} />);

    expect(document.querySelectorAll(".view-header")).toHaveLength(1);
    expect(document.querySelectorAll(".view-action-button--create")).toHaveLength(0);
    const header = document.querySelector(".view-header") as HTMLElement;
    expect(header.contains(screen.getByTestId("reports-compare-button"))).toBe(true);
  });
});
