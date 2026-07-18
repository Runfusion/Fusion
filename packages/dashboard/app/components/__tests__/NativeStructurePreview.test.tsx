import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NativeStructurePreviewPayload, NativeStructureRef } from "@fusion/core";
import { fetchNativeStructurePreview } from "../../api";
import { NativeStructurePreview } from "../NativeStructurePreview";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({ fetchNativeStructurePreview: vi.fn() }));
const fetchPreview = vi.mocked(fetchNativeStructurePreview);

const refs: NativeStructureRef[] = [
  { kind: "mission", id: "M-1" },
  { kind: "milestone", id: "MS-1" },
  { kind: "research-finding", id: "INS-1" },
  { kind: "eval-result", id: "EV-1" },
  { kind: "goal", id: "G-1" },
];

function payload(ref: NativeStructureRef): NativeStructurePreviewPayload {
  const views = { mission: "missions", milestone: "missions", "research-finding": "insights", "eval-result": "evals", goal: "goals" } as const;
  return { available: true, kind: ref.kind, kindLabel: ref.kind, title: `${ref.kind} title`, excerpt: "Compact excerpt", openTarget: { view: views[ref.kind], id: ref.id } };
}

describe("NativeStructurePreview", () => {
  it.each(refs)("renders pre-resolved %s cards without fetching", (ref) => {
    const onOpen = vi.fn();
    render(<NativeStructurePreview ref={ref} payload={payload(ref)} onOpen={onOpen} />);
    expect(screen.getByTestId("native-structure-preview")).toHaveAttribute("data-kind", ref.kind);
    expect(screen.getByText(`${ref.kind} title`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp("Open") })).toBeInTheDocument();
    expect(fetchPreview).not.toHaveBeenCalled();
  });

  it.each(refs)("fetches and renders a ref-only %s card", async (ref) => {
    const result = payload(ref);
    fetchPreview.mockResolvedValueOnce(result);
    render(<NativeStructurePreview ref={ref} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("native-structure-preview")).toHaveAttribute("data-kind", ref.kind));
    expect(fetchPreview).toHaveBeenCalledWith(ref);
    expect(screen.getByText(`${ref.kind} title`)).toBeInTheDocument();
  });

  it("dispatches consumer navigation without a dead anchor", () => {
    const ref = refs[0];
    const result = payload(ref);
    const onOpen = vi.fn();
    const { container } = render(<NativeStructurePreview ref={ref} payload={result} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Open mission: mission title" }));
    expect(onOpen).toHaveBeenCalledWith(ref, result);
    expect(container.querySelector('a[href*="/missions/"]')).toBeNull();
  });

  it.each(["missing", "soft-deleted"] as const)("renders a graceful %s placeholder", (reason) => {
    render(<NativeStructurePreview ref={refs[0]} payload={{ available: false, kind: "mission", id: "M-1", reason }} onOpen={vi.fn()} />);
    expect(screen.getByTestId("native-structure-preview-unavailable")).toHaveAttribute("data-reason", reason);
    expect(screen.getByText("This structure is unavailable.")).toBeInTheDocument();
  });

  it("does not render a previous ref's fetched payload after a ref change", async () => {
    fetchPreview.mockResolvedValueOnce(payload(refs[0]));
    const { rerender } = render(<NativeStructurePreview ref={refs[0]} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("mission title")).toBeInTheDocument());

    fetchPreview.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<NativeStructurePreview ref={refs[1]} onOpen={vi.fn()} />);

    expect(screen.getByTestId("native-structure-preview-loading")).toBeInTheDocument();
    expect(screen.queryByText("mission title")).toBeNull();
  });

  it("renders a deliberate error card when fetching fails", async () => {
    fetchPreview.mockRejectedValueOnce(new Error("offline"));
    render(<NativeStructurePreview ref={refs[0]} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("native-structure-preview-error")).toBeInTheDocument());
  });

  it("lets a later caller-supplied payload replace a failed fetch", async () => {
    fetchPreview.mockRejectedValueOnce(new Error("offline"));
    const { rerender } = render(<NativeStructurePreview ref={refs[0]} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("native-structure-preview-error")).toBeInTheDocument());

    rerender(<NativeStructurePreview ref={refs[0]} payload={payload(refs[0])} onOpen={vi.fn()} />);

    expect(screen.getByTestId("native-structure-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("native-structure-preview-error")).toBeNull();
  });

  it("keeps the open affordance inside the mobile layout contract", () => {
    const { container } = render(<NativeStructurePreview ref={refs[0]} payload={payload(refs[0])} onOpen={vi.fn()} />);
    expect(container.querySelector(".native-structure-preview__open")).toBeInTheDocument();
    const css = loadAllAppCss();
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.native-structure-preview__open/);
  });
});
