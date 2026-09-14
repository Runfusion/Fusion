import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";

/*
FNXC:StandardizedViewLayout 2026-09-13-21:49:
FN-379 requires every recorded dialog, confirmation, onboarding, and window surface — not only the components that
already used the shared header — to build its chrome from the canonical primitives. This suite mounts each of those
REAL producers on a desktop viewport and on a phone viewport and proves the contract behaviourally: exactly one
header zone owns the title, any creation entry lives in that header and nowhere else, and a phone renders no second
local title row. Surfaces that deliberately expose no exit keep none; the guard never invents one.
*/

/*
Per-case overrides let a surface that only reveals its chrome after real data (stash recovery, workflow output)
state the exact response it needs, while every other member stays inert.
*/
const apiOverrides = new Map<string, (...args: never[]) => unknown>();

/** Any api member resolves to an inert value so a dialog can mount without a server. */
function inertApiModule() {
  const cache = new Map<string, unknown>();
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property: string) {
      if (property === "__esModule") return true;
      if (property === "then") return undefined;

      if (!cache.has(property)) {
        /*
        Producers read these responses as arrays OR as envelopes, so the inert value is an empty array carrying
        empty collection fields: it stays iterable, keeps a zero length, and never fabricates business data.
        */
        cache.set(property, vi.fn(async (...args: never[]) => {
          /*
          ESM binds the named import once, so the override is consulted per CALL rather than per import: a case
          that needs real data can state it after the producer already captured the binding.
          */
          const override = apiOverrides.get(property);
          if (override) return override(...args);
          return Object.assign([] as unknown[], {
          entries: [],
          items: [],
          tasks: [],
          agents: [],
          nodes: [],
          records: [],
          projects: [],
          conflicts: [],
          checks: [],
          providers: [],
          windows: [],
          ok: true,
          title: "",
          body: "",
          branch: "",
          name: "",
          diff: "",
          });
        }));
      }
      return cache.get(property);
    },
    has() {
      return true;
    },
  });
}

vi.mock("../../api", () => inertApiModule());
vi.mock("../../api/legacy", () => inertApiModule());
vi.mock("../../utils/copyToClipboard", () => ({ copyTextToClipboard: vi.fn(async () => true) }));

import { AddNodeModal } from "../AddNodeModal";
import { AgentErrorDetailsModal } from "../AgentErrorDetailsModal";
import { AgentListModal } from "../AgentListModal";
import { AgentOnboardingModal } from "../AgentOnboardingModal";
import { ChangesDiffModal } from "../ChangesDiffModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { ConnectNodeModal } from "../ConnectNodeModal";
import { CreateRoomModal } from "../CreateRoomModal";
import { DockerNodeOnboardingModal } from "../DockerNodeOnboardingModal";
import { DuplicateWarningModal } from "../DuplicateWarningModal";
import { ExperimentalAgentOnboardingModal } from "../ExperimentalAgentOnboardingModal";
import { GroupTaskModal } from "../GroupTaskModal";
import { ModelSelectionModal } from "../ModelSelectionModal";
import { NativeShellConnectionManager } from "../NativeShellConnectionManager";
import { NativeShellOnboardingModal } from "../NativeShellOnboardingModal";
import { NodeDetailModal } from "../NodeDetailModal";
import { PrCreateModal } from "../PrCreateModal";
import { ProviderLoginDialog } from "../ProviderLoginDialog";
import { ResearchTaskActionModal } from "../ResearchTaskActionModal";
import { SettingsSyncConflictModal } from "../SettingsSyncConflictModal";
import StashConflictModal from "../StashConflictModal";
import { TaskResetDialog } from "../TaskResetDialog";
import { UsageIndicator } from "../UsageIndicator";
import { ReliabilityView } from "../ReliabilityView";
import { StashRecoveryView } from "../StashRecoveryView";
import { WorkflowResultsTab } from "../WorkflowResultsTab";

const originalWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query.includes("max-width") || query.includes("max-height")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  document.documentElement.dataset.viewportMode = mode;
}

function mount(ui: ReactElement) {
  return render(<ViewLayoutProvider projectId="project-dialogs">{ui}</ViewLayoutProvider>);
}

const noop = () => {};
const asyncNoop = async () => undefined;
const addToast = vi.fn();

const shellState = {
  host: "browser" as const,
  status: "connected" as const,
  profiles: [],
  activeProfileId: null,
  desktopMode: "remote" as const,
};
const shellApi = new Proxy({}, { get: () => vi.fn(async () => undefined) });

type DialogCase = {
  /** Inventory destination name. */
  name: string;
  /** Visible title the shared header must own. */
  title: RegExp;
  /** Mounts the real producer. */
  render: () => void;
  /** This surface intentionally exposes no close control (its own decision buttons are its exits). */
  noExit?: boolean;
  /** Header-owned creation entry, proven unique across the whole surface. */
  creation?: { testId: string; label: RegExp };
};

const CASES: DialogCase[] = [
  {
    name: "Add node",
    title: /Add Node/,
    render: () => mount(
      <AddNodeModal
        isOpen
        onClose={noop}
        onSubmit={asyncNoop}
        onDiscoverRemoteProjects={async () => ({ projects: [] }) as never}
        addToast={addToast}
        projects={[]}
      />,
    ),
  },
  {
    name: "Agent error details",
    title: /Agent Error Details/,
    render: () => mount(
      <AgentErrorDetailsModal open onClose={noop} errorText="boom" issueContext={{ surface: "agents" } as never} />,
    ),
  },
  {
    name: "Agents window",
    title: /^Agents$/,
    creation: { testId: "agent-list-modal-create", label: /New Agent/ },
    render: () => mount(<AgentListModal isOpen onClose={noop} addToast={addToast} projectId="p1" />),
  },
  {
    name: "Agent onboarding",
    title: /Agent Onboarding/,
    render: () => mount(
      <AgentOnboardingModal isOpen onClose={noop} onCreated={noop} addToast={addToast} existingAgents={[]} />,
    ),
  },
  {
    name: "Changes diff",
    title: /Changes/,
    render: () => mount(
      <ChangesDiffModal
        isOpen
        taskId="FN-001"
        files={[]}
        stats={{ filesChanged: 0, additions: 0, deletions: 0 }}
        onClose={noop}
      />,
    ),
  },
  {
    name: "Confirmation",
    title: /Delete this task\?/,
    render: () => mount(
      <ConfirmDialog
        isOpen
        options={{ title: "Delete this task?", message: "This cannot be undone." } as never}
        onConfirm={noop}
        onCancel={noop}
      />,
    ),
  },
  {
    name: "Connect node",
    title: /Connect to Node/,
    render: () => mount(<ConnectNodeModal open onClose={noop} onConnected={noop} addToast={addToast} />),
  },
  {
    name: "Create room",
    title: /Create room/,
    render: () => mount(<CreateRoomModal isOpen onClose={noop} onCreate={noop} projectId="p1" />),
  },
  {
    name: "Docker node onboarding",
    title: /Provision Docker Node/,
    render: () => mount(<DockerNodeOnboardingModal isOpen onClose={noop} onSubmit={asyncNoop} addToast={addToast} />),
  },
  {
    name: "Duplicate warning",
    title: /Possible duplicates/,
    noExit: true,
    render: () => mount(<DuplicateWarningModal matches={[]} onOpen={noop} onProceed={noop} onCancel={noop} />),
  },
  {
    name: "Experimental agent onboarding",
    title: /AI Interview/,
    render: () => mount(
      <ExperimentalAgentOnboardingModal isOpen onClose={noop} onUseDraft={noop} existingAgents={[]} />,
    ),
  },
  {
    name: "Branch group",
    title: /Branch Group/,
    render: () => mount(<GroupTaskModal isOpen onClose={noop} groupId="grp-1" onOpenMemberTask={noop} />),
  },
  {
    name: "Model selection",
    title: /Select Models/,
    render: () => mount(
      <ModelSelectionModal
        isOpen
        onClose={noop}
        models={[]}
        executorValue=""
        validatorValue=""
        onExecutorChange={noop}
        onValidatorChange={noop}
      />,
    ),
  },
  {
    name: "Connection manager",
    title: /Connection Manager/,
    render: () => mount(
      <NativeShellConnectionManager open shellApi={shellApi as never} shellState={shellState as never} onClose={noop} />,
    ),
  },
  {
    name: "Native shell onboarding",
    title: /Welcome to Fusion/,
    noExit: true,
    render: () => mount(
      <NativeShellOnboardingModal open shellApi={shellApi as never} shellState={shellState as never} onComplete={noop} />,
    ),
  },
  {
    name: "Node detail",
    title: /Node Details/,
    render: () => mount(
      <NodeDetailModal
        isOpen
        onClose={noop}
        node={{ id: "node-1", name: "Build server", status: "online", url: "http://localhost:3001" } as never}
        projects={[]}
        onUpdate={asyncNoop}
        onHealthCheck={asyncNoop}
        addToast={addToast}
      />,
    ),
  },
  {
    name: "Create pull request",
    title: /Create Pull Request/,
    render: () => mount(
      <PrCreateModal open taskId="FN-001" onClose={noop} onCreated={noop} addToast={addToast} />,
    ),
  },
  {
    name: "Provider login",
    title: /Signing in to/,
    render: () => mount(
      <ProviderLoginDialog
        providerName="Anthropic"
        phase="waiting"
        manualCode={{ prompt: "Paste the code" }}
        codeValue=""
        onCodeChange={noop}
        onSubmitCode={noop}
        onOpenAuthUrl={noop}
        onCancel={noop}
      />,
    ),
  },
  {
    name: "Research task action",
    title: /Create task from finding/,
    render: () => mount(
      <ResearchTaskActionModal
        open
        mode="create"
        run={{ id: "run-1" } as never}
        finding={{ id: "finding-1", heading: "Observation" }}
        onClose={noop}
        onConfirm={asyncNoop}
      />,
    ),
  },
  {
    name: "Settings sync conflicts",
    title: /Resolve Settings Conflicts/,
    render: () => mount(
      <SettingsSyncConflictModal
        isOpen
        onClose={noop}
        onResolve={asyncNoop}
        conflicts={[{ key: "scheduling.maxConcurrent", scope: "global", local: 2, remote: 4 } as never]}
        localNodeName="local"
        remoteNodeName="remote"
        addToast={addToast}
      />,
    ),
  },
  {
    name: "Stash conflicts",
    title: /Resolve auto-stash conflicts/,
    noExit: true,
    render: () => mount(
      <StashConflictModal
        open
        onClose={noop}
        worktreePath="/repo"
        integrationBranch="main"
        stashSha="abcdef1234"
        stashLabel="fusion autostash"
        conflictedFiles={["src/app.ts"]}
        autostashOutcome="conflict-needs-manual"
      />,
    ),
  },
  {
    name: "Task reset",
    title: /Reset this task\?/,
    render: () => mount(
      <TaskResetDialog taskId="FN-001" onReset={asyncNoop} addToast={addToast} onClose={noop} />,
    ),
  },
  {
    name: "Usage",
    title: /^Usage$/,
    render: () => mount(<UsageIndicator isOpen onClose={noop} projectId="p1" />),
  },
];

function sharedHeaders(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".view-header"));
}

describe("FN-379 standardized dialog chrome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiOverrides.clear();
    localStorage.clear();
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    apiOverrides.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    delete document.documentElement.dataset.viewportMode;
  });

  for (const dialogCase of CASES) {
    it.each(["desktop", "mobile"] as const)(`${dialogCase.name} owns one shared header with its exit and creation (%s)`, async (mode) => {
      setViewport(mode);
      dialogCase.render();

      await waitFor(() => expect(sharedHeaders().length).toBeGreaterThan(0));
      const headers = sharedHeaders();
      // One visual authority: a surface never stacks its own title row beside the shared header.
      expect(headers).toHaveLength(1);
      const header = headers[0];
      expect(within(header).getByText(dialogCase.title)).toBeInTheDocument();
      // No second heading competes with the header title anywhere in the surface.
      const surface = header.closest(".modal, .view-layout, .usage-modal") ?? header.parentElement!;
      const headings = Array.from(surface.querySelectorAll("h1, h2, h3")).filter((node) => !header.contains(node));
      expect(headings.map((node) => node.textContent?.trim()).filter((text) => text && dialogCase.title.test(text))).toEqual([]);

      const closes = Array.from(surface.querySelectorAll(".modal-close"));
      if (dialogCase.noExit) {
        expect(closes).toHaveLength(0);
      } else {
        // Exactly one exit, built by the canonical primitive, inside the shared header.
        expect(closes).toHaveLength(1);
        expect(header.contains(closes[0])).toBe(true);
        expect(closes[0].getAttribute("aria-label")).toBeTruthy();
      }

      if (dialogCase.creation) {
        const creations = Array.from(surface.querySelectorAll(`[data-testid="${dialogCase.creation.testId}"]`));
        expect(creations).toHaveLength(1);
        expect(header.contains(creations[0])).toBe(true);
        // The label survives the phone collapse as the accessible name.
        expect(creations[0].getAttribute("aria-label") ?? creations[0].textContent ?? "").toMatch(dialogCase.creation.label);
        expect(creations[0].className).toContain("view-action-button");
        // No duplicate creation entry outside the header.
        const duplicates = Array.from(surface.querySelectorAll("button"))
          .filter((button) => button !== creations[0] && dialogCase.creation!.label.test(button.textContent ?? ""));
        expect(duplicates).toEqual([]);
      }
    });
  }

  /*
  Reliability's destructive reset is an in-view confirmation: it shares the canonical header and keeps Cancel/Reset
  as its only exits, so no close control is invented above an irreversible choice.
  */
  it.each(["desktop", "mobile"] as const)("gives the reliability reset confirmation the shared header (%s)", async (mode) => {
    setViewport(mode);
    const reliabilityPayload = async () => ({
      windowDays: 7,
      generatedAt: "2026-09-13T00:00:00.000Z",
      resetAt: null,
      headline: { inReviewFailureRate7d: 0.2 },
      perDay: [],
      duration: { p50Ms: 1000, p95Ms: 2000, sampleCount: 2 },
      mergeAttempts: { mean: 1, max: 1, histogram: { "1": 1 } },
    });
    apiOverrides.set("api", reliabilityPayload as never);
    mount(<ReliabilityView projectId="p1" />);

    const reset = await screen.findByRole("button", { name: /Reset stats/ });
    expect(sharedHeaders()).toHaveLength(0);
    fireEvent.click(reset);

    await waitFor(() => expect(sharedHeaders()).toHaveLength(1));
    const header = sharedHeaders()[0];
    expect(within(header).getByText(/Reset reliability stats\?/)).toBeInTheDocument();
    expect(document.querySelectorAll(".modal-close")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
  });

  /*
  Stash recovery reveals a nested diff dialog only for a real record; that dialog shares the header and its close
  dismisses only the diff, never the recovery list behind it.
  */
  it.each(["desktop", "mobile"] as const)("gives the stash recovery diff dialog the shared header (%s)", async (mode) => {
    setViewport(mode);
    const stashResponses = async (path: string) => {
      if (path.endsWith("/diff")) return { diff: "--- a\n+++ b", truncated: false };
      return {
        records: [{
          sha: "abcdef1234567",
          sourceTaskId: "FN-001",
          classification: "merger-autostash",
          changedPaths: ["src/app.ts"],
          createdAt: "2026-09-13T00:00:00.000Z",
          truncated: false,
        }],
      };
    };
    apiOverrides.set("api", stashResponses as never);
    mount(<StashRecoveryView />);

    const inspect = await screen.findByRole("button", { name: /Inspect diff/ });
    fireEvent.click(inspect);

    await waitFor(() => expect(sharedHeaders()).toHaveLength(1));
    const header = sharedHeaders()[0];
    expect(within(header).getByText(/Diff for/)).toBeInTheDocument();
    const close = header.querySelector<HTMLElement>(".modal-close")!;
    expect(close).toBeTruthy();
    fireEvent.click(close);
    // Closing the nested diff returns to the recovery list instead of dismissing the surface behind it.
    await waitFor(() => expect(sharedHeaders()).toHaveLength(0));
    expect(screen.getByRole("button", { name: /Inspect diff/ })).toBeInTheDocument();
  });

  /*
  The expanded workflow output dialog shares the header: rich step identity as title, its render-mode control as a
  header action, and one canonical close.
  */
  it.each(["desktop", "mobile"] as const)("gives the expanded workflow output the shared header (%s)", async (mode) => {
    setViewport(mode);
    mount(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[{
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "passed",
          output: "All good",
          phase: "pre-merge",
        } as never]}
      />,
    );

    fireEvent.click(await screen.findByTestId("workflow-result-toggle-code-review"));
    const expand = await screen.findByTestId("workflow-result-expand-code-review");
    fireEvent.click(expand);

    await waitFor(() => expect(sharedHeaders()).toHaveLength(1));
    const header = sharedHeaders()[0];
    expect(within(header).getByText("Code Review")).toBeInTheDocument();
    expect(within(header).getByTestId("workflow-output-modal-mode-toggle")).toBeInTheDocument();
    const closes = Array.from(document.querySelectorAll('[data-testid="workflow-output-modal-close"]'));
    expect(closes).toHaveLength(1);
    expect(header.contains(closes[0])).toBe(true);
  });

  /*
  Scripts is the list/detail member of this family: its single creation belongs to the header, the collection is
  the shared rail, and the phone presents one pane at a time with the shared chevron as the return.
  */
  it("keeps the Scripts creation in the header and its collection in the shared rail", async () => {
    const { ScriptsModal } = await import("../ScriptsModal");
    setViewport("desktop");
    mount(<ScriptsModal isOpen onClose={noop} addToast={addToast} projectId="p1" />);

    const surface = await screen.findByTestId("scripts-modal");
    const header = surface.querySelector<HTMLElement>(".view-header")!;
    const create = await screen.findByTestId("add-script-btn");
    expect(header.contains(create)).toBe(true);
    expect(create.className).toContain("view-action-button");
    expect(surface.querySelectorAll('[data-testid="add-script-btn"]')).toHaveLength(1);
    expect(screen.getByTestId("scripts-modal-rail")).toBeInTheDocument();
    expect(surface.getAttribute("data-mobile-pane")).toBe("list");
    // No back affordance while the collection pane is the one presented.
    expect(screen.queryByTestId("scripts-modal-back")).toBeNull();

    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId("script-name-input")).toBeInTheDocument());
    // Creating switches the phone presentation to the detail pane behind the shared return.
    expect(surface.getAttribute("data-mobile-pane")).toBe("detail");
    const back = screen.getByTestId("scripts-modal-back");
    expect(header.contains(back)).toBe(true);
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByTestId("script-name-input")).toBeNull());
    expect(surface.getAttribute("data-mobile-pane")).toBe("list");
  });
});
