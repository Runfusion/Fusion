import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportFiltersBar } from "../components/ReportFiltersBar.js";

const filters = { cadence: "all", status: "all", from: "", to: "", q: "", agentId: "" } as const;

describe("ReportFiltersBar", () => {
  it("emits changes", async () => {
    const onChange = vi.fn();
    const { getByPlaceholderText } = render(<ReportFiltersBar filters={{ ...filters }} onChange={onChange} agents={[]} />);
    fireEvent.change(getByPlaceholderText("Search title"), { target: { value: "hello" } });
    await waitFor(() => expect(onChange).toBeCalled());
  });
});
