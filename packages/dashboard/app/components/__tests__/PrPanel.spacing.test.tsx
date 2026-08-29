import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrPanel } from "../PrPanel";

vi.mock("../../api", () => ({
  refreshPrStatus: vi.fn(),
  fetchPrChecks: vi.fn().mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: null }),
  fetchPrReviews: vi.fn().mockResolvedValue({ snapshot: { decision: null, items: [] }, comments: [] }),
  mergePr: vi.fn(),
  reclaimPrConflict: vi.fn(),
  setAutoMergeOnGreen: vi.fn(),
  unlinkPr: vi.fn(),
}));

const stylesPath = path.resolve(__dirname, "../../styles.css");
const stylesSource = fs.readFileSync(stylesPath, "utf-8");

const baseProps = {
  taskId: "FN-5596",
  prAuthAvailable: true,
  onPrUpdated: vi.fn(),
  addToast: vi.fn(),
};

const prInfo = {
  url: "https://github.com/owner/repo/pull/42",
  number: 42,
  status: "open" as const,
  title: "Tokenized spacing",
  headBranch: "fusion/fn-5596",
  baseBranch: "main",
  commentCount: 1,
};

describe("PrPanel spacing contract", () => {
  it("declares .pr-card tokenized padding and gap in styles.css", () => {
    expect(stylesSource).toContain(".pr-card {");
    const start = stylesSource.indexOf(".pr-card {");
    const block = stylesSource.slice(start, start + 260);
    expect(block).toContain("padding: var(--space-md);");
    expect(block).toContain("gap: var(--space-sm);");
  });

  it("keeps px font-size literals out of the PR section block", () => {
    const prSectionStart = stylesSource.indexOf("/* === PR Section === */");
    const nextSectionStart = stylesSource.indexOf("/* ===", prSectionStart + 1);
    const prSectionBlock = stylesSource.slice(prSectionStart, nextSectionStart);
    expect(prSectionBlock).not.toContain("font-size: 12px;");
    expect(prSectionBlock).not.toContain("font-size: 13px;");
    expect(prSectionBlock).not.toContain("font-size: 14px;");
    expect(prSectionBlock).not.toContain("font-size: 16px;");
  });

  it("renders create PR empty-state with subtle hint callout", () => {
    render(<PrPanel {...baseProps} onRequestCreatePr={vi.fn()} isManualPrFlow />);
    expect(screen.getByRole("button", { name: "Create PR" })).toBeInTheDocument();
    expect(document.querySelector(".pr-section .pr-hint--subtle")).not.toBeNull();
  });

  it("renders multi-PR summary and stacked cards", () => {
    render(
      <PrPanel
        {...baseProps}
        prInfos={[prInfo, { ...prInfo, number: 43, title: "Second PR" }]}
      />,
    );

    expect(document.querySelector(".pr-panel-summary")).not.toBeNull();
    const stack = document.querySelector(".pr-panel-stack");
    expect(stack).not.toBeNull();
    expect(stack?.querySelectorAll(".pr-card")).toHaveLength(2);
  });
});
