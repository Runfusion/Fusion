/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { RoadmapsView } from "../RoadmapsView";
import * as api from "../api";

/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
FN-379 proves the Roadmaps destination behaviourally on desktop and phone: one cooperative header owns the title
and the single creation entry, that entry collapses to an icon with its accessible name on a phone, and an empty
collection never grows a second creation affordance.
*/

vi.mock("../api", () => ({
  fetchRoadmaps: vi.fn(),
  fetchRoadmap: vi.fn(),
  createRoadmap: vi.fn(),
  updateRoadmap: vi.fn(),
  deleteRoadmap: vi.fn(),
  createRoadmapMilestone: vi.fn(),
  updateRoadmapMilestone: vi.fn(),
  deleteRoadmapMilestone: vi.fn(),
  createRoadmapFeature: vi.fn(),
  updateRoadmapFeature: vi.fn(),
  deleteRoadmapFeature: vi.fn(),
  reorderRoadmapMilestones: vi.fn(),
  reorderRoadmapFeatures: vi.fn(),
  moveRoadmapFeature: vi.fn(),
  generateFeatureSuggestions: vi.fn(),
  generateMilestoneSuggestions: vi.fn(),
}));

vi.mock("../useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));

function setViewport(mode: "desktop" | "mobile") {
  document.documentElement.dataset.viewportMode = mode;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && query.includes("max-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe("Roadmaps standardized view layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchRoadmaps).mockResolvedValue([] as never);
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.viewportMode;
  });

  it("keeps one canonical header owning the single creation entry on desktop", async () => {
    render(<RoadmapsView projectId="proj-roadmap" addToast={vi.fn()} />);
    await waitFor(() => expect(api.fetchRoadmaps).toHaveBeenCalled());

    expect(document.querySelectorAll(".view-header")).toHaveLength(1);
    const create = screen.getByTestId("create-roadmap-header-btn");
    expect(document.querySelector(".view-header")?.contains(create)).toBe(true);
    expect(screen.getAllByRole("button", { name: "Create roadmap" })).toHaveLength(1);
  });

  it("collapses the phone creation entry to an icon that keeps its accessible name", async () => {
    setViewport("mobile");
    render(<RoadmapsView projectId="proj-roadmap" addToast={vi.fn()} />);
    await waitFor(() => expect(api.fetchRoadmaps).toHaveBeenCalled());

    const create = screen.getByTestId("create-roadmap-header-btn");
    expect(create).toHaveClass("view-action-button--mobile-icon-only");
    expect(create).toHaveAccessibleName("Create roadmap");
    expect(create.querySelector("svg")).toBeTruthy();
  });
});
