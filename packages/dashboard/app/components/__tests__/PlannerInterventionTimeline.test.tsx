/*
FNXC:PlannerOversight 2026-07-04-18:00:
FN-7519 Surface Enumeration coverage for the standalone PlannerInterventionTimeline
component: empty state (no leftover shell), hidden (oversight Off / undefined
oversight fields), single/many entries (newest-first ordering assumed to
already be provided by the read path), partial entries (no attempt badge, no
links row), every source-link kind, and unknown enum fallback labels.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { PlannerInterventionEntry } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchPlannerInterventionTimeline: vi.fn(),
}));

import { fetchPlannerInterventionTimeline } from "../../api";
import { PlannerInterventionTimeline } from "../PlannerInterventionTimeline";

const mockFetch = vi.mocked(fetchPlannerInterventionTimeline);

function makeEntry(overrides: Partial<PlannerInterventionEntry> = {}): PlannerInterventionEntry {
  return {
    id: "evt-1",
    taskId: "FN-100",
    timestamp: "2026-07-04T10:00:00.000Z",
    stage: "executor",
    reason: "Executor stalled without progress",
    action: "retry",
    outcome: "pending",
    attemptCount: 1,
    attemptLimit: 3,
    sourceLinks: [{ kind: "agent-log", label: "Agent log", target: "run-1" }],
    ...overrides,
  };
}

describe("PlannerInterventionTimeline", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("renders the calm empty state (not an empty shell) when there are no interventions", async () => {
    mockFetch.mockResolvedValue({ entries: [] });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    expect(await screen.findByTestId("planner-intervention-timeline-empty")).toHaveTextContent("No planner interventions yet");
    expect(screen.queryByTestId("planner-intervention-entry")).not.toBeInTheDocument();
  });

  it("renders nothing (no leftover container) when hidden (oversight Off / undefined oversight fields)", async () => {
    mockFetch.mockResolvedValue({ entries: [makeEntry()] });
    const { container } = render(<PlannerInterventionTimeline taskId="FN-100" hidden />);

    // Give any stray effect a tick to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("planner-intervention-timeline")).not.toBeInTheDocument();
  });

  it("never throws when interventions resolve to an empty array (covers the safe-empty contract)", async () => {
    mockFetch.mockResolvedValue({ entries: [] });
    expect(() => render(<PlannerInterventionTimeline taskId="FN-100" />)).not.toThrow();
    await waitFor(() => expect(screen.getByTestId("planner-intervention-timeline-empty")).toBeInTheDocument());
  });

  it("renders a single entry with all six field groups", async () => {
    mockFetch.mockResolvedValue({ entries: [makeEntry()] });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    const entry = await screen.findByTestId("planner-intervention-entry");
    expect(entry).toHaveTextContent("Executor stalled without progress");
    expect(await screen.findByTestId("planner-intervention-entry-attempts")).toHaveTextContent("1/3");
    expect(await screen.findByTestId("planner-intervention-entry-links")).toBeInTheDocument();
    expect(screen.getByTestId("planner-intervention-source-link")).toBeInTheDocument();
  });

  it("renders many entries newest-first as provided by the read path", async () => {
    mockFetch.mockResolvedValue({
      entries: [
        makeEntry({ id: "evt-2", reason: "Second (newest)", timestamp: "2026-07-04T11:00:00.000Z" }),
        makeEntry({ id: "evt-1", reason: "First (oldest)", timestamp: "2026-07-04T10:00:00.000Z" }),
      ],
    });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    const entries = await screen.findAllByTestId("planner-intervention-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("Second (newest)");
    expect(entries[1]).toHaveTextContent("First (oldest)");
  });

  it("renders a partial entry without the attempt badge and without the links row", async () => {
    mockFetch.mockResolvedValue({
      entries: [makeEntry({ attemptCount: undefined, attemptLimit: undefined, sourceLinks: undefined })],
    });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    await screen.findByTestId("planner-intervention-entry");
    expect(screen.queryByTestId("planner-intervention-entry-attempts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("planner-intervention-entry-links")).not.toBeInTheDocument();
  });

  it("omits the attempt badge when only one of attemptCount/attemptLimit is present", async () => {
    mockFetch.mockResolvedValue({
      entries: [makeEntry({ attemptCount: 2, attemptLimit: undefined })],
    });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    await screen.findByTestId("planner-intervention-entry");
    expect(screen.queryByTestId("planner-intervention-entry-attempts")).not.toBeInTheDocument();
  });

  it("renders each source-link kind with a graceful fallback when target/url is absent", async () => {
    mockFetch.mockResolvedValue({
      entries: [
        makeEntry({
          id: "evt-links",
          sourceLinks: [
            { kind: "agent-log", label: "Agent log", target: "run-1" },
            { kind: "review-comment", label: "Review comment", target: "cmt-1" },
            { kind: "failed-check", label: "Failed check", target: "ci-build" },
            { kind: "merge-error", label: "Merge error" },
            { kind: "pr-state", label: "PR state", url: "https://example.test/pr/1" },
            { kind: "url", label: "Generic link" },
          ],
        }),
      ],
    });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    const links = await screen.findAllByTestId("planner-intervention-source-link");
    expect(links).toHaveLength(6);
    // The pr-state link has a url and renders as an anchor; the rest lack a url and degrade to inert spans.
    const prStateLink = links.find((el) => el.textContent?.includes("PR state"));
    expect(prStateLink?.tagName).toBe("A");
    const mergeErrorLink = links.find((el) => el.textContent?.includes("Merge error"));
    expect(mergeErrorLink?.tagName).toBe("SPAN");
  });

  it("renders a safe fallback label for an unknown stage/action/outcome value instead of crashing", async () => {
    mockFetch.mockResolvedValue({
      entries: [
        makeEntry({
          stage: "some-future-stage" as unknown as PlannerInterventionEntry["stage"],
          action: "some-future-action" as unknown as PlannerInterventionEntry["action"],
          outcome: "some-future-outcome" as unknown as PlannerInterventionEntry["outcome"],
        }),
      ],
    });
    expect(() => render(<PlannerInterventionTimeline taskId="FN-100" />)).not.toThrow();
    await screen.findByTestId("planner-intervention-entry");
  });

  it("renders once per host (no duplicate data-testid) for a single mount", async () => {
    mockFetch.mockResolvedValue({ entries: [makeEntry()] });
    render(<PlannerInterventionTimeline taskId="FN-100" />);

    await screen.findByTestId("planner-intervention-timeline");
    expect(screen.getAllByTestId("planner-intervention-timeline")).toHaveLength(1);
  });
});
