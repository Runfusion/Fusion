import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportActionMenu } from "../ReportActionMenu";

describe("ReportActionMenu", () => {
  it("exposes all four guided actions without empty controls", () => {
    const onSelect = vi.fn();
    render(<ReportActionMenu onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    const actions = ["Report bug", "Send feedback", "Share idea", "Get help"];
    for (const action of actions) expect(screen.getByRole("menuitem", { name: action })).toBeEnabled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Get help" }));
    expect(onSelect).toHaveBeenCalledWith("help");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
