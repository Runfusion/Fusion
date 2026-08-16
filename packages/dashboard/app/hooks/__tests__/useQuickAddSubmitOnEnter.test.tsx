import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuickAddSubmitOnEnterProvider, useQuickAddSubmitOnEnter } from "../useQuickAddSubmitOnEnter";

function PreferenceValue() {
  return <output>{String(useQuickAddSubmitOnEnter())}</output>;
}

describe("useQuickAddSubmitOnEnter", () => {
  it("defaults to enabled without a provider", () => {
    render(<PreferenceValue />);
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("reads a disabled provider value", () => {
    render(<QuickAddSubmitOnEnterProvider enabled={false}><PreferenceValue /></QuickAddSubmitOnEnterProvider>);
    expect(screen.getByText("false")).toBeInTheDocument();
  });

  it("reads an enabled provider value", () => {
    render(<QuickAddSubmitOnEnterProvider enabled><PreferenceValue /></QuickAddSubmitOnEnterProvider>);
    expect(screen.getByText("true")).toBeInTheDocument();
  });
});
