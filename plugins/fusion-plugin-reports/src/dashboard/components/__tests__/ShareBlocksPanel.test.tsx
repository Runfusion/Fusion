import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareBlocksPanel } from "../ShareBlocksPanel.js";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

const getShareBlocks = vi.fn();
vi.mock("../../api.js", () => ({ getShareBlocks: (...args: unknown[]) => getShareBlocks(...args) }));

describe("ShareBlocksPanel", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    Object.defineProperty(document, "execCommand", { configurable: true, value: originalExecCommand });
    getShareBlocks.mockReset();
  });

  it("renders tabs and copies selected block", async () => {
    getShareBlocks.mockResolvedValue({ plainText: "a", markdown: "b", slack: "c", emailHtml: "d" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<ShareBlocksPanel report={{ id: "rep_1" } as any} />);
    await screen.findByText("Plain Text");
    fireEvent.click(screen.getByText("Markdown"));
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("b"));
  });

  it("copies selected block through execCommand when Clipboard API is unavailable", async () => {
    getShareBlocks.mockResolvedValue({ plainText: "a", markdown: "b", slack: "c", emailHtml: "d" });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    render(<ShareBlocksPanel report={{ id: "rep_1" } as any} />);
    await screen.findByText("Plain Text");
    fireEvent.click(screen.getByText("Markdown"));
    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("does not show copied when both clipboard paths fail", async () => {
    getShareBlocks.mockResolvedValue({ plainText: "a", markdown: "b", slack: "c", emailHtml: "d" });
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    render(<ShareBlocksPanel report={{ id: "rep_1" } as any} />);
    await screen.findByText("Plain Text");
    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("shows locked message on 409", async () => {
    getShareBlocks.mockRejectedValue(new Error("409 Conflict"));
    render(<ShareBlocksPanel report={{ id: "rep_1" } as any} />);
    await screen.findByText(/unlock after the report is approved/i);
  });
});
