import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileBrowserProvider, useFileBrowser } from "../FileBrowserContext";

function Probe() {
  const fileBrowser = useFileBrowser();
  return <div data-testid="probe">{fileBrowser ? "present" : "missing"}</div>;
}

describe("FileBrowserContext", () => {
  it("returns null outside the provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("missing");
  });

  it("returns the provided value inside the provider", () => {
    const openFile = vi.fn();
    render(
      <FileBrowserProvider openFile={openFile}>
        <Probe />
      </FileBrowserProvider>,
    );

    expect(screen.getByTestId("probe")).toHaveTextContent("present");
  });
});
