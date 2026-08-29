import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as preview from "../useReportPreview.js";
import { ReportComparisonDrawer } from "../components/ReportComparisonDrawer.js";

describe("ReportComparisonDrawer", () => {
  it("renders compare ui", () => {
    vi.spyOn(preview, "useReportPreview").mockReturnValue({ html: "<article />", loading: false, error: null });
    const { getByText } = render(<ReportComparisonDrawer reports={[{ id: "R-1", title: "A" }, { id: "R-2", title: "B" }] as never} leftId="R-1" rightId="R-2" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(getByText("Compare reports")).toBeInTheDocument();
  });
});
