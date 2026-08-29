import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DiscoveryResult } from "../../artifacts/discovery.js";

// Mock the network layer so the view renders from seeded discovery results.
const listArtifacts = vi.fn(async (_projectId?: string): Promise<DiscoveryResult> => {
  throw new Error("listArtifacts mock not configured");
});
const listSessions = vi.fn(async (): Promise<CeSession[]> => []);
const deleteSession = vi.fn(async (_id: string, _projectId?: string): Promise<void> => undefined);
const cancelSession = vi.fn(async (_id: string, _projectId?: string): Promise<CeSession> => {
  throw new Error("cancelSession mock not configured");
});
const getSession = vi.fn(async (_id: string, _projectId?: string): Promise<CeSession> => {
  throw new Error("getSession mock not configured");
});
const startSession = vi.fn(async (_stage: string, _opts?: unknown): Promise<CeSession> => {
  throw new Error("startSession mock not configured");
});
vi.mock("../hooks/api.js", () => ({
  listArtifacts: (projectId?: string) => listArtifacts(projectId),
  getArtifactPreviewUrl: (id: string) => `/preview/${id}`,
  listSessions: () => listSessions(),
  deleteSession: (id: string, projectId?: string) => deleteSession(id, projectId),
  cancelSession: (id: string, projectId?: string) => cancelSession(id, projectId),
  getSession: (id: string, projectId?: string) => getSession(id, projectId),
  startSession: (stage: string, opts?: unknown) => startSession(stage, opts),
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
  { stage: "ideate", label: "Ideate" },
  { stage: "brainstorm", label: "Brainstorms" },
  { stage: "plan", label: "Plan" },
  { stage: "work", label: "Work" },
  { stage: "debug", label: "Debug" },
  { stage: "compound", label: "Learnings" },
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
    window.history.replaceState({}, "", "/");
    __test_clearArtifactsCache();
    listArtifacts.mockReset();
    listSessions.mockReset();
    listSessions.mockResolvedValue([]);
    deleteSession.mockReset();
    deleteSession.mockResolvedValue(undefined);
    cancelSession.mockReset();
    cancelSession.mockImplementation(async (id: string, projectId?: string) => mkCeSession({ id, projectId: projectId ?? null, status: "interrupted", error: "Cancelled by user" }));
    getSession.mockReset();
    startSession.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it("renders the empty / first-run state with an orientation + start action", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-empty-state");
    expect(listArtifacts).toHaveBeenCalledWith("p1");
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
    expect(document.querySelector('.ce-groups [data-stage="strategy"]')).toHaveAttribute("data-layout", "singleton");
  });

  it("presents brainstorm and plan artifacts as repeatable collections", async () => {
    listArtifacts.mockResolvedValue(
      makeResult({
        plan: [
          { kind: "artifact", id: "plan:docs/plans/requirements.md", stage: "plan", path: "docs/plans/requirements.md", name: "requirements.md", size: 5, updatedAt: 3, artifactContract: "ce-unified-plan/v1", artifactReadiness: "requirements-only", productContractSource: "ce-brainstorm" },
          { kind: "artifact", id: "plan:docs/plans/ready.md", stage: "plan", path: "docs/plans/ready.md", name: "ready.md", size: 5, updatedAt: 2, artifactContract: "ce-unified-plan/v1", artifactReadiness: "implementation-ready", productContractSource: "ce-brainstorm" },
          { kind: "artifact", id: "plan:docs/plans/legacy.md", stage: "plan", path: "docs/plans/legacy.md", name: "legacy.md", size: 5, updatedAt: 1 },
        ],
      }),
    );

    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-summary");
    const brainstorms = document.querySelector('.ce-groups [data-stage="brainstorm"]')!;
    const plans = document.querySelector('.ce-groups [data-stage="plan"]')!;
    expect(brainstorms).toHaveTextContent("Brainstorms");
    expect(brainstorms.querySelectorAll('[data-testid="ce-artifact"]')).toHaveLength(1);
    expect(plans).toHaveTextContent("Plans");
    expect(plans.querySelectorAll('[data-testid="ce-artifact"]')).toHaveLength(2);
  });

  it("keeps long artifact histories collapsed after the four newest entries", async () => {
    listArtifacts.mockResolvedValue(
      makeResult({
        plan: Array.from({ length: 6 }, (_, index) => ({
          kind: "artifact" as const,
          id: `plan:docs/plans/${index}.md`,
          stage: "plan",
          path: `docs/plans/${index}.md`,
          name: `${index}.md`,
          size: 5,
          updatedAt: 6 - index,
        })),
      }),
    );

    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    const plans = await screen.findByRole("heading", { name: "Plans" });
    const group = plans.closest<HTMLElement>("[data-testid='ce-group']")!;
    expect(group.querySelectorAll("[data-testid='ce-artifact']")).toHaveLength(6);
    const disclosure = within(group).getByText("Show all 6").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(within(group).getByText("Show all 6"));
    expect(disclosure).toHaveAttribute("open");
  });

  it("normalizes legacy solution groups into Compound learnings", async () => {
    const result = makeResult({});
    result.groups = result.groups.filter((group) => group.stage !== "compound");
    result.groups.push({
      stage: "solution",
      label: "Solutions",
      present: true,
      entries: [{ kind: "artifact", id: "solution:docs/solutions/learned.md", stage: "solution", path: "docs/solutions/learned.md", name: "learned.md", size: 5, updatedAt: 1 }],
    });
    result.totalArtifacts = 1;
    listArtifacts.mockResolvedValue(result);

    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    expect(await screen.findByRole("heading", { name: "Learnings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Solutions" })).not.toBeInTheDocument();
    const compound = screen.getAllByTestId("ce-pipeline-stage").find((node) => node.getAttribute("data-stage") === "compound");
    expect(compound).toHaveTextContent("1 artifact");
  });

  it("opens an artifact in the built-in file viewer via context.openFile", async () => {
    const openFile = vi.fn();
    listArtifacts.mockResolvedValue(
      makeResult({
        strategy: [
          { kind: "artifact", id: "strategy:STRATEGY.md", stage: "strategy", path: "STRATEGY.md", name: "STRATEGY.md", size: 10, updatedAt: 1 },
        ],
      }),
    );
    render(
      <CompoundEngineeringView
        projectId="p1"
        enabledOverride
        context={{ openFile, tasks: [], workflowSteps: [], openTaskDetail: vi.fn() }}
      />,
    );

    await screen.findByTestId("ce-artifact");
    fireEvent.click(screen.getByTestId("ce-artifact-open"));
    expect(openFile).toHaveBeenCalledWith("STRATEGY.md", { workspace: "project" });
  });

  it("renders artifact open button without crashing when openFile is not in context", async () => {
    listArtifacts.mockResolvedValue(
      makeResult({
        strategy: [
          { kind: "artifact", id: "strategy:STRATEGY.md", stage: "strategy", path: "STRATEGY.md", name: "STRATEGY.md", size: 10, updatedAt: 1 },
        ],
      }),
    );
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-artifact");
    const open = screen.getByTestId("ce-artifact-open");
    expect(open).toBeInTheDocument();
    fireEvent.click(open);
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
    // Only non-terminal sessions can be cancelled; only terminal sessions can be discarded.
    const cancelButtons = screen.getAllByTestId("ce-session-cancel");
    expect(cancelButtons).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Cancel session" })).toHaveLength(2);
    for (const cancelButton of cancelButtons) {
      expect(cancelButton).toHaveAccessibleName("Cancel session");
      expect(cancelButton).toHaveAttribute("title", "Cancel session");
      expect(cancelButton).not.toHaveTextContent(/cancel/i);
    }
    expect(screen.getAllByTestId("ce-session-discard")).toHaveLength(1);
    expect(rows[0].querySelector("[data-testid='ce-session-cancel']")).toBeInTheDocument();
    expect(rows[1].querySelector("[data-testid='ce-session-cancel']")).toBeInTheDocument();
    expect(rows[2].querySelector("[data-testid='ce-session-cancel']")).not.toBeInTheDocument();
    expect(screen.getByTestId("ce-resume-latest")).toHaveTextContent(/input needed/i);
    expect(screen.getAllByTestId("ce-pipeline-stage")).toHaveLength(6);
    expect(screen.getByText("Foundation")).toBeInTheDocument();
    expect(screen.getByText("Delivery loop")).toBeInTheDocument();
    expect(screen.getByText("Build, simplify, and review")).toBeInTheDocument();
  });

  it("renders no cancel affordance for an empty sessions list", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([]);
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-empty-state");
    expect(screen.queryByTestId("ce-session-cancel")).not.toBeInTheDocument();
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

  it("hands optional foundation sessions directly into Brainstorm", async () => {
    const strategy = mkCeSession({ id: "strategy-done", stage: "strategy", status: "completed" });
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([strategy]);
    getSession.mockResolvedValue(strategy);
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    fireEvent.click((await screen.findAllByTestId("ce-session-open"))[0]);

    expect(await screen.findByRole("button", { name: "Start Brainstorm" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Ideate" })).not.toBeInTheDocument();
  });

  it("cancels an in-flight session via the list", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([mkCeSession({ id: "running", stage: "plan", status: "active" })]);
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-sessions");
    listSessions.mockResolvedValue([mkCeSession({ id: "running", stage: "plan", status: "interrupted", error: "Cancelled by user" })]);
    fireEvent.click(screen.getByTestId("ce-session-cancel"));

    await waitFor(() => expect(cancelSession).toHaveBeenCalledWith("running", "p1"));
    await waitFor(() => expect(screen.queryByTestId("ce-session-cancel")).not.toBeInTheDocument());
    expect(screen.getByTestId("ce-session-discard")).toBeInTheDocument();
  });

  it("cancels an open flow and returns to the refreshed sessions overview", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([mkCeSession({ id: "flow", stage: "plan", status: "active" })]);
    getSession.mockResolvedValue(mkCeSession({ id: "flow", stage: "plan", status: "active" }));
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-sessions");
    fireEvent.click(screen.getByTestId("ce-session-open"));
    await screen.findByTestId("ce-flow");
    expect(new URLSearchParams(window.location.search).get("ceSession")).toBe("flow");
    listSessions.mockResolvedValue([mkCeSession({ id: "flow", stage: "plan", status: "interrupted", error: "Cancelled by user" })]);
    fireEvent.click(screen.getByTestId("ce-flow-cancel"));

    await waitFor(() => expect(cancelSession).toHaveBeenCalledWith("flow", "p1"));
    await waitFor(() => expect(screen.queryByTestId("ce-flow")).not.toBeInTheDocument());
    expect(new URLSearchParams(window.location.search).has("ceSession")).toBe(false);
    expect(screen.getByTestId("ce-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("ce-session-discard")).toBeInTheDocument();
  });

  it("writes a newly launched session to the URL", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    startSession.mockResolvedValue(mkCeSession({ id: "new-strategy", stage: "strategy", status: "active" }));
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    fireEvent.click(await screen.findByTestId("ce-start-action"));
    const strategy = (await screen.findAllByTestId("ce-launcher-stage")).find(
      (node) => node.getAttribute("data-stage") === "strategy",
    )!;
    fireEvent.click(strategy);

    await screen.findByTestId("ce-flow");
    expect(new URLSearchParams(window.location.search).get("ceSession")).toBe("new-strategy");
  });

  it("discards a terminal session via the list", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    listSessions.mockResolvedValue([mkCeSession({ id: "done", stage: "plan", status: "completed" })]);
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    await screen.findByTestId("ce-sessions");
    listSessions.mockResolvedValue([]);
    fireEvent.click(screen.getByTestId("ce-session-discard"));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("ce-discard-confirm")).toHaveTextContent(/delete permanently/i);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("done", "p1"));
    await waitFor(() => expect(screen.queryByTestId("ce-sessions")).not.toBeInTheDocument());
  });

  it("shows unified plan readiness and distinguishes artifact history from completed runs", async () => {
    listArtifacts.mockResolvedValue(makeResult({
      plan: [{
        kind: "artifact",
        id: "plan:docs/plans/ready.md",
        stage: "plan",
        path: "docs/plans/ready.md",
        name: "ready.md",
        size: 10,
        updatedAt: 2,
        artifactContract: "ce-unified-plan/v1",
        artifactReadiness: "implementation-ready",
      }],
    }));
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    expect(await screen.findByText("Implementation ready")).toBeInTheDocument();
    const plan = screen.getAllByTestId("ce-pipeline-stage").find((node) => node.getAttribute("data-stage") === "plan")!;
    expect(plan).toHaveTextContent("History");
    const brainstorm = screen.getAllByTestId("ce-pipeline-stage").find((node) => node.getAttribute("data-stage") === "brainstorm")!;
    expect(brainstorm).toHaveTextContent("History");
  });

  it("keeps Plan incomplete when only a requirements artifact exists", async () => {
    listArtifacts.mockResolvedValue(makeResult({
      plan: [{
        kind: "artifact",
        id: "plan:docs/plans/requirements.md",
        stage: "plan",
        path: "docs/plans/requirements.md",
        name: "requirements.md",
        size: 10,
        updatedAt: 2,
        artifactContract: "ce-unified-plan/v1",
        artifactReadiness: "requirements-only",
      }],
    }));
    render(<CompoundEngineeringView projectId="p1" enabledOverride />);

    const stages = await screen.findAllByTestId("ce-pipeline-stage");
    expect(stages.find((node) => node.getAttribute("data-stage") === "brainstorm")).toHaveTextContent("History");
    expect(stages.find((node) => node.getAttribute("data-stage") === "plan")).toHaveTextContent("Not started");
  });

  it("does not fetch when the viewport-gated flag is disabled", async () => {
    listArtifacts.mockResolvedValue(makeResult({}));
    render(<CompoundEngineeringView projectId="p1" enabledOverride={false} />);
    // Give effects a tick.
    await waitFor(() => expect(screen.getByTestId("compound-engineering-view")).toBeInTheDocument());
    expect(listArtifacts).not.toHaveBeenCalled();
  });
});
