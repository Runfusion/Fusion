import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { StashRecoveryView } from "../StashRecoveryView";

const apiMock = vi.fn();
const confirmMock = vi.fn();

vi.mock("../../api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: confirmMock }) }));

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function expectRootGrowContract(css: string, selector: string) {
  const rootBlock = extractRuleBlock(css, selector);

  expect(rootBlock).toMatch(/flex\s*:\s*1\s+1\s+auto/);
  expect(rootBlock).toMatch(/min-width\s*:\s*0/);
  expect(rootBlock).toMatch(/width\s*:\s*100%/);
}

describe("StashRecoveryView", () => {
  it("grows the root container to fill the project-content flex row", () => {
    expectRootGrowContract(loadAllAppCss(), ".stash-recovery-view");
    expectRootGrowContract(loadAllAppCssBaseOnly(), ".stash-recovery-view");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state", async () => {
    apiMock.mockResolvedValueOnce({ records: [] });
    render(<StashRecoveryView />);
    expect(await screen.findByText(/No orphaned merger autostashes found/i)).toBeInTheDocument();
  });

  it("renders grouped rows and apply", async () => {
    apiMock.mockResolvedValueOnce({ records: [{ sha: "abcdef123", sourceTaskId: "FN-1", createdAt: null, classification: "live", changedPaths: ["a"] }] });
    apiMock.mockResolvedValueOnce({ ok: false, reason: "conflict", stderr: "conflict text" });
    render(<StashRecoveryView />);
    expect(await screen.findByText("FN-1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(screen.getByText(/conflict text/i)).toBeInTheDocument());
  });

  it("opens inspect diff modal", async () => {
    apiMock.mockResolvedValueOnce({ records: [{ sha: "abcdef123", sourceTaskId: "FN-1", createdAt: null, classification: "live", changedPaths: ["a"] }] });
    apiMock.mockResolvedValueOnce({ diff: "patch-content", truncated: false });
    render(<StashRecoveryView />);
    await screen.findByText("FN-1");
    fireEvent.click(screen.getByText("Inspect diff"));
    expect(await screen.findByText(/Diff for abcdef1/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("patch-content")).toBeInTheDocument());
  });

  it("drop requires confirmation", async () => {
    apiMock.mockResolvedValueOnce({ records: [{ sha: "abcdef123", sourceTaskId: null, createdAt: null, classification: "live", changedPaths: [] }] });
    confirmMock.mockResolvedValueOnce(false);
    render(<StashRecoveryView />);
    await screen.findByText("Unknown source");
    fireEvent.click(screen.getByText("Drop"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
