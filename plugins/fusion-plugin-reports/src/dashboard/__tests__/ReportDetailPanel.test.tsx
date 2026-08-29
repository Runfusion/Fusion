import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as preview from "../useReportPreview.js";
import { ReportDetailPanel } from "../components/ReportDetailPanel.js";

describe("ReportDetailPanel", () => {
  it("renders report", () => {
    vi.spyOn(preview, "useReportPreview").mockReturnValue({ html: "<article />", loading: false, error: null });
    const { getByText } = render(<ReportDetailPanel report={{ id: "R-1", title: "Report", cadence: "daily", status: "published", periodStart: "2026-01-01", periodEnd: "2026-01-02" } as never} />);
    expect(getByText("Report")).toBeInTheDocument();
  });
});
