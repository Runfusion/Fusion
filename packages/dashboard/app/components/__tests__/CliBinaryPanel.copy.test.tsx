import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CliBinaryPanel } from "../CliBinaryPanel";
import { fetchFnBinaryStatus, installFnBinary } from "../../api/legacy";

vi.mock("../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  fetchFnBinaryStatus: vi.fn(),
  installFnBinary: vi.fn(),
}));

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function mockClipboardFallback(result: boolean) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const execCommand = vi.fn().mockReturnValue(result);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
}

function mockStatus() {
  vi.mocked(fetchFnBinaryStatus).mockResolvedValue({
    binary: { binary: "fn", installed: false, path: null, version: null },
    expectedVersion: "1.2.3",
    state: "missing",
    install: {
      npm: "npm install -g @runfusion/fusion",
      curl: "curl -fsSL https://example.test/install.sh | sh",
    },
  });
  vi.mocked(installFnBinary).mockResolvedValue({} as never);
}

describe("CliBinaryPanel clipboard copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    Object.defineProperty(document, "execCommand", { configurable: true, value: originalExecCommand });
  });

  it("shows Copied after the execCommand fallback succeeds", async () => {
    const execCommand = mockClipboardFallback(true);
    render(<CliBinaryPanel />);
    await screen.findByText("npm install -g @runfusion/fusion");

    await userEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("stays silent and does not show Copied when both clipboard paths fail", async () => {
    const execCommand = mockClipboardFallback(false);
    render(<CliBinaryPanel />);
    await screen.findByText("npm install -g @runfusion/fusion");

    await userEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
  });
});
