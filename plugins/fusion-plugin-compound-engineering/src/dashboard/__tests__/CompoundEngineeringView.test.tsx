import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiscoveryResult } from "../../artifacts/discovery.js";

// Mock the network layer so the view renders from seeded discovery results.
const listArtifacts = vi.fn(async (): Promise<DiscoveryResult> => {
  throw new Error("listArtifacts mock not configured");
});
const listSessions = vi.fn(async (): Promise<CeSession[]> => []);
const deleteSession = vi.fn(async (_id: string, _projectId?: string): Promise<void> => undefined);
const getSession = vi.fn(async (_id: string, _projectId?: string): Promise<CeSession> => {
  throw new Error("getSession mock not configured");
});
vi.mock("../hooks/api.js", () => ({
  listArtifacts: () => listArtifacts(),
  getArtifactPreviewUrl: (id: string) => `/preview/${id}`,
  listSessions: () => listSessions(),
  deleteSession: (id: string, projectId?: string) => deleteSession(id, projectId),
  getSession: (id: string, projectId?: string) => getSession(id, projectId),
  startSession: vi.fn(),
  answerSession: vi.fn(),
  resumeSession: vi.fn(),
}));

import { CompoundEngineeringView } from "../CompoundEngineeringView.js";
import { __test_clearArtifactsCache } from "../hooks/useArtifacts.js";
import type { CeSession } from "../../session/session-store.js";

function mkCeSession(over: Partial<CeSession>): CeSession {
  return {
    id: "sess-1",
    stage: "brainstorm",
    status: "awaiting_input",
    currentQuestion: null,
    conversationHistory: [],
    projectId: "p1",
    artifactPath: null,
    error: null,
    turnIntervalMs: 1000,
    lastActivityAt: Date.now(),
    createdAt: "2026-06-03T00:00:00Z",
    updatedAt: "2026-06-03T00:00:00Z",
    ...over,
  };
}

const ALL_STAGES: Array<{ stage: DiscoveryResult["groups"][number]["stage"]; label: string }> = [
  { stage: "strategy", label: "Strategy" },
  { stage: "ideation", label: "Ideation" },
  { stage: "brainstorm", label: "Brainstorms" },
  { stage: "plan", label: "Plans" },
  { stage: "solution", label: "Solutions" },
  { stage: "concepts", label: "Concepts" },
];

function makeResult(overrides: Partial<Record<DiscoveryResult["groups"][number]["stage"], DiscoveryResult["groups"][number]["entries"]>>): DiscoveryResult {
  const groups = ALL_STAGES.map(({ stage, label }) => ({
    stage,
    label,
    present: Boolean(overrides[stage]?.length),
    entries: overrides[stage] ?? [],
  }));
  let totalArtifacts = 0;
  let totalErrors = 0;
  for (const g of groups) {
    for (const e of g.entries) {
      if (e.kind === "artifact") totalArtifacts += 1;
      else totalErrors += 1;
    }
  }
  return { groups, totalArtifacts, totalErrors };
}

describe("CompoundEngineeringView", () => {
  beforeEach(() => {
    __test_clearArtifactsCache();
    listArtifacts.mockReset();
    listSessions.mockReset();
    listSessions.mockResolvedValue([]);
    deleteSession.mockReset();
    deleteSession.mockResolvedValue(undefined);
    getSession.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it("renders the empty / first-run state with an orientation + start action", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-empty-state");
    expect(screen.getByText(/Start your compounding pipeline/i)).toBeInTheDocument();
    const start = screen.getByTestId("ce-start-action");
    expect(start).toBeInTheDocument();
    // Start affordance is wired to a placeholder (toast); clicking does not throw.
    fireEvent.click(start);
  });

  it("renders the partial-discovery state (some categories present, others empty)", async () => {
    listArtifacts.mockResolvedValue(
      makeResult({
        strategy: [
          { kind: "artifact", id: "strategy:STRATEGY.md", stage: "strategy", path: "STRATEGY.md", name: "STRATEGY.md", size: 10, updatedAt: 1 },
        ],
        plan: [
          { kind: "artifact", id: "plan:docs/plans/p.md", stage: "plan", path: "docs/plans/p.md", name: "p.md", size: 5, updatedAt: 2 },
        ],
      }),
    );
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-summary");
    // Partial flag surfaces in the summary and on the groups container.
    expect(screen.getByTestId("ce-summary").textContent).toMatch(/partial/i);
    const groups = screen.getByTestId("ce-summary").closest(".ce-view")!.querySelector(".ce-groups");
    expect(groups?.getAttribute("data-partial")).toBe("true");
    // Populated groups render artifacts; empty ones render an empty hint.
    expect(screen.getAllByTestId("ce-artifact")).toHaveLength(2);
    expect(screen.getAllByTestId("ce-group-empty").length).toBeGreaterThan(0);
  });

  it("renders an error entry for an unreadable artifact (not a crash or silent drop)", async () => {
    listArtifacts.mockResolvedValue(
      makeResult({
        plan: [
          { kind: "error", id: "plan:docs/plans/bad.md", stage: "plan", path: "docs/plans/bad.md", name: "bad.md", error: "EIO: simulated read failure" },
        ],
      }),
    );
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    const errorEntry = await screen.findByTestId("ce-artifact-error");
    expect(errorEntry).toBeInTheDocument();
    expect(errorEntry.textContent).toMatch(/simulated read failure/i);
    // Surfaced as an unreadable count in the summary.
    expect(screen.getByTestId("ce-summary").textContent).toMatch(/unreadable/i);
  });

  it("lists multiple sessions with status badges; terminal sessions get a discard affordance", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([
      mkCeSession({ id: "a", stage: "brainstorm", status: "awaiting_input" }),
      mkCeSession({ id: "b", stage: "plan", status: "active" }),
      mkCeSession({ id: "c", stage: "work", status: "completed" }),
    ]);
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-sessions");
    const rows = screen.getAllByTestId("ce-session-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual([
      "awaiting_input",
      "active",
      "completed",
    ]);
    // Awaiting sessions advertise that they need the user.
    expect(rows[0].textContent).toMatch(/needs your input/i);
    // Only the terminal session can be discarded.
    expect(screen.getAllByTestId("ce-session-discard")).toHaveLength(1);
  });

  it("opens an existing session from the list into the flow (and back without losing it)", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([
      mkCeSession({ id: "a", stage: "brainstorm", status: "awaiting_input" }),
      mkCeSession({ id: "b", stage: "plan", status: "active" }),
    ]);
    getSession.mockResolvedValue(
      mkCeSession({
        id: "a",
        status: "awaiting_input",
        currentQuestion: { id: "q1", type: "text", question: "Topic?" },
      }),
    );
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-sessions");
    fireEvent.click(screen.getAllByTestId("ce-session-open")[0]);

    // The flow surface opens on the adopted session…
    const flow = await screen.findByTestId("ce-flow");
    expect(flow.getAttribute("data-stage")).toBe("brainstorm");
    expect(getSession).toHaveBeenCalledWith("a", "p1");
    // …while the sessions panel stays visible for switching, with the open
    // session marked active.
    expect(screen.getByTestId("ce-sessions")).toBeInTheDocument();
    const rows = screen.getAllByTestId("ce-session-row");
    expect(rows[0].className).toMatch(/is-active/);

    // Closing returns to the overview; the session list survives (the session
    // itself keeps running server-side — close does not delete anything).
    fireEvent.click(screen.getByText("Close"));
    await screen.findByTestId("ce-empty-state");
    expect(screen.getByTestId("ce-sessions")).toBeInTheDocument();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("discards a terminal session via the list", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([mkCeSession({ id: "done", stage: "plan", status: "completed" })]);
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-sessions");
    listSessions.mockResolvedValue([]);
    fireEvent.click(screen.getByTestId("ce-session-discard"));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("done", "p1"));
    await waitFor(() => expect(screen.queryByTestId("ce-sessions")).not.toBeInTheDocument());
  });

  it("does not fetch when the viewport-gated flag is disabled", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    render(<CompoundEngineeringView projectId="p1" enabledOverride={false} />);
    // Give effects a tick.
    await waitFor(() => expect(screen.getByTestId("compound-engineering-view")).toBeInTheDocument());
    expect(listArtifacts).not.toHaveBeenCalled();
  });
});
