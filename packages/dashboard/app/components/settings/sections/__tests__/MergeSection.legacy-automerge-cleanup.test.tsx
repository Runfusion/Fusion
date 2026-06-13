import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MergeSection } from "../MergeSection";
import type { MergeSectionProps } from "../MergeSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

function makeProps(): MergeSectionProps {
  return {
    scopeBanner: null,
    form: {
      autoMerge: true,
      merger: { mode: "ai" },
      testMode: false,
      mergeStrategy: "direct",
    } as MergeSectionProps["form"],
    setForm: vi.fn(),
    integrationBranchOptions: ["main"],
    integrationBranchCustomMode: false,
    setIntegrationBranchCustomMode: vi.fn(),
  };
}

describe("MergeSection legacy auto-merge stamp cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.innerWidth = 1024;
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("renders the store-provided candidate list without client-side filtering", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      candidates: [
        { taskId: "FN-101", column: "in-review", cleared: false },
        { taskId: "FN-USER", column: "in-review", cleared: false },
      ],
      count: 2,
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<MergeSection {...makeProps()} />);

    await waitFor(() => expect(screen.getByText("FN-101")).toBeInTheDocument());
    expect(screen.getByText("FN-USER")).toBeInTheDocument();
    expect(screen.getAllByTestId("legacy-automerge-stamp-candidate-row")).toHaveLength(2);
    expect(screen.getByTestId("legacy-automerge-stamp-apply-button")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/maintenance/legacy-automerge-stamps");
  });

  it("renders an explicit empty state and no apply shell when there are zero candidates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ candidates: [], count: 0 })));

    render(<MergeSection {...makeProps()} />);

    expect(await screen.findByTestId("legacy-automerge-stamp-empty-state")).toHaveTextContent(
      "No legacy auto-merge stamps to clean up.",
    );
    expect(screen.queryByTestId("legacy-automerge-stamp-apply-button")).not.toBeInTheDocument();
  });

  it("requires confirmation, posts apply, and re-fetches to the empty state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ taskId: "FN-101", column: "in-review", cleared: false }],
        count: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({
        cleared: [{ taskId: "FN-101", column: "in-review", cleared: true }],
        count: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({ candidates: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<MergeSection {...makeProps()} />);

    fireEvent.click(await screen.findByTestId("legacy-automerge-stamp-apply-button"));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("never touches genuine per-task overrides"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/maintenance/legacy-automerge-stamps/apply",
      { method: "POST" },
    ));
    expect(await screen.findByTestId("legacy-automerge-stamp-empty-state")).toBeInTheDocument();
  });

  it("is operable at a narrow mobile width", async () => {
    window.innerWidth = 390;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      candidates: [{ taskId: "FN-MOBILE", column: "in-review", cleared: false }],
      count: 1,
    })));

    render(<MergeSection {...makeProps()} />);

    expect(await screen.findByText("FN-MOBILE")).toBeInTheDocument();
    const applyButton = screen.getByTestId("legacy-automerge-stamp-apply-button");
    expect(applyButton.tagName).toBe("BUTTON");
    expect(applyButton).toHaveTextContent("Apply cleanup");
  });
});
