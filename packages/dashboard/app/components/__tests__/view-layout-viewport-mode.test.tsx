import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import { ViewLayout } from "../ViewLayout";
import { ViewSidebar } from "../ViewSidebar";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import * as viewportModule from "../../hooks/useViewportMode";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 keeps the phone presentation bound to the canonical viewport classifier. The raw `(max-height: 480px)`
arm also matches a short desktop window and a desktop shrunk by a virtual keyboard, so a rule that only excluded
tablets would hide one of a desktop's panes and collapse its actions to icons. Every phone rule in the shared
primitives is therefore gated on `data-viewport-mode="mobile"`, with a width-only pre-hydration fallback.
*/

vi.mock("../../hooks/useViewportMode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useViewportMode")>();
  return { ...actual, useViewportMode: vi.fn(() => "desktop") };
});

const mockUseViewportMode = vi.mocked(viewportModule.useViewportMode);

const SHARED_PRIMITIVE_CSS = [
  "components/ViewLayout.css",
  "components/ViewSidebar.css",
  "components/ViewActionButton.css",
] as const;

/** Returns each `@media` block of a stylesheet with its condition text. */
function mediaBlocks(css: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = [];
  const pattern = /@media([^{]+)\{/g;
  let match = pattern.exec(css);
  while (match) {
    let depth = 1;
    let index = pattern.lastIndex;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push({ condition: match[1].trim(), body: css.slice(pattern.lastIndex, index - 1) });
    pattern.lastIndex = index;
    match = pattern.exec(css);
  }
  return blocks;
}

/** Selector heads declared inside a media block body, comments stripped. */
function selectors(body: string): string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((chunk) => chunk.split("{")[0]?.trim() ?? "")
    .filter(Boolean)
    .flatMap((group) => group.split(",").map((one) => one.trim()))
    .filter(Boolean);
}

describe("FN-379 phone presentation follows the canonical viewport classifier", () => {
  afterEach(() => {
    cleanup();
    mockUseViewportMode.mockReturnValue("desktop");
    document.documentElement.removeAttribute("data-viewport-mode");
  });

  it.each(SHARED_PRIMITIVE_CSS)("gates every short-viewport rule of %s on the published mobile mode", (file) => {
    const offenders: string[] = [];
    for (const block of mediaBlocks(readAppFile(file))) {
      if (!block.condition.includes("max-height: 480px")) continue;
      for (const selector of selectors(block.body)) {
        if (!selector.startsWith('html[data-viewport-mode="mobile"]')) offenders.push(`${file}: ${block.condition} → ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(SHARED_PRIMITIVE_CSS)("keeps the pre-hydration fallback of %s width-only and attribute-free", (file) => {
    const offenders: string[] = [];
    for (const block of mediaBlocks(readAppFile(file))) {
      const fallbackSelectors = selectors(block.body).filter((selector) => selector.startsWith("html:not([data-viewport-mode])"));
      if (fallbackSelectors.length === 0) continue;
      if (block.condition.includes("max-height")) offenders.push(`${file}: ${block.condition}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never marks a short desktop rail as a phone rail", () => {
    mockUseViewportMode.mockReturnValue("desktop");
    render(
      <ViewLayoutProvider projectId="p-1">
        <ViewLayout header={<div>Header</div>} sidebar={<ViewSidebar ariaLabel="Collection"><div>rail</div></ViewSidebar>}>
          <div>detail</div>
        </ViewLayout>
      </ViewLayoutProvider>,
    );

    expect(screen.getByRole("complementary", { name: "Collection" }).closest(".view-sidebar")).not.toHaveClass("view-sidebar--mobile");
    expect(screen.getByTestId("view-layout-content")).toBeInTheDocument();
  });

  it("never marks a known tablet rail as a phone rail", () => {
    mockUseViewportMode.mockReturnValue("tablet");
    render(
      <ViewLayoutProvider projectId="p-1">
        <ViewLayout header={<div>Header</div>} sidebar={<ViewSidebar ariaLabel="Collection"><div>rail</div></ViewSidebar>}>
          <div>detail</div>
        </ViewLayout>
      </ViewLayoutProvider>,
    );

    expect(screen.getByRole("complementary", { name: "Collection" }).closest(".view-sidebar")).not.toHaveClass("view-sidebar--mobile");
  });

  it("marks a phone rail — including landscape, which is short and wide — as the phone presentation", () => {
    mockUseViewportMode.mockReturnValue("mobile");
    render(
      <ViewLayoutProvider projectId="p-1">
        <ViewLayout header={<div>Header</div>} mobilePane="list" sidebar={<ViewSidebar ariaLabel="Collection"><div>rail</div></ViewSidebar>}>
          <div>detail</div>
        </ViewLayout>
      </ViewLayoutProvider>,
    );

    expect(screen.getByRole("complementary", { name: "Collection" }).closest(".view-sidebar")).toHaveClass("view-sidebar--mobile");
    expect(screen.getByTestId("view-layout-content").closest(".view-layout")).toHaveAttribute("data-mobile-pane", "list");
  });
});
