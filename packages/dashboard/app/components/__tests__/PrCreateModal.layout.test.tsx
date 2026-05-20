import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrCreateModal } from "../PrCreateModal";
import { loadAllAppCss } from "../../test/cssFixture";

const mocks = vi.hoisted(() => ({
  generatePrMetadata: vi.fn(),
  fetchPrPreflight: vi.fn(),
  fetchPrOptions: vi.fn(),
  createPr: vi.fn(),
}));

vi.mock("../../api", () => ({
  generatePrMetadata: mocks.generatePrMetadata,
  fetchPrPreflight: mocks.fetchPrPreflight,
  fetchPrOptions: mocks.fetchPrOptions,
  createPr: mocks.createPr,
}));

describe("PrCreateModal layout", () => {
  let styleEl: HTMLStyleElement;

  beforeAll(() => {
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterAll(() => {
    styleEl.remove();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generatePrMetadata.mockResolvedValue({ title: "AI title", body: "AI body", templateUsed: false });
    mocks.fetchPrPreflight.mockResolvedValue({
      branchOnRemote: true,
      commitsPresent: true,
      conflictsWithBase: false,
      ghAuthOk: true,
      defaultBaseBranch: "main",
      head: "fusion/FN-5049",
      commits: [],
      changedFiles: [],
    });
    mocks.fetchPrOptions.mockResolvedValue({
      baseBranches: ["main"],
      reviewers: [],
      assignees: [],
      labels: [],
    });
  });

  it("renders a dedicated scroll body between modal header and actions", async () => {
    render(<PrCreateModal open taskId="FN-5049" onClose={vi.fn()} onCreated={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => expect(mocks.generatePrMetadata).toHaveBeenCalled());

    const dialog = screen.getByRole("dialog");
    const modal = dialog.classList.contains("modal") ? dialog : dialog.closest(".modal");
    expect(modal).toBeTruthy();

    const header = modal?.querySelector(":scope > .modal-header");
    const body = modal?.querySelector(":scope > .pr-create-modal__body");
    const actions = modal?.querySelector(":scope > .modal-actions");

    expect(header).toBeTruthy();
    expect(body).toBeTruthy();
    expect(actions).toBeTruthy();
    expect(actions?.parentElement).toBe(modal);

    const allAutoOverflow = Array.from(modal?.querySelectorAll<HTMLElement>("*") ?? []).filter(
      (element) => getComputedStyle(element).overflowY === "auto",
    );
    expect(allAutoOverflow).toHaveLength(1);
    expect(allAutoOverflow[0]).toBe(body);
  });
});
