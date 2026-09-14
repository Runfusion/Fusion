import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type { ArtifactWithTask } from "@fusion/core";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 remediation: the window-shaped producers (agent creation/import/generation, onboarding, the first-run
wizard, artifact viewers, the workflow step picker, and reporting) kept a LOCAL header row whose class name the
earlier ratchet never looked at. They now build the canonical header, and this suite proves it behaviourally on a
desktop viewport and on a phone viewport: one header zone owns the title, the single exit is the canonical close
control inside that header, and no local title row survives beside it.
*/

const apiOverrides = new Map<string, (...args: never[]) => unknown>();

/** Any api member resolves to an inert value so a window can mount without a server. */
function inertApiModule() {
  const cache = new Map<string, unknown>();
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property: string) {
      if (property === "__esModule") return true;
      if (property === "then") return undefined;
      if (property === "artifactMediaUrl" || property === "artifactMediaUrlWithToken") {
        return (id: string) => `/api/artifacts/${id}/media`;
      }
      if (!cache.has(property)) {
        cache.set(property, vi.fn(async (...args: never[]) => {
          const override = apiOverrides.get(property);
          if (override) return override(...args);
          return Object.assign([] as unknown[], {
            providers: [],
            models: [],
            entries: [],
            items: [],
            agents: [],
            projects: [],
            repos: [],
            companies: [],
            ok: true,
            enabled: false,
            content: "",
            title: "",
            body: "",
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
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmWithChoice: vi.fn(async () => null) }),
}));
vi.mock("../../hooks/useNodes", () => ({ useNodes: () => ({ nodes: [], loading: false }) }));
vi.mock("../../hooks/useArtifactImageBlob", () => ({
  useArtifactImageBlob: () => ({ url: "blob:secure-preview", loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("../../utils/report-capture", () => ({
  captureScreenshot: vi.fn(async () => undefined),
  getRecentActivity: () => [],
  recordActivity: vi.fn(),
}));

import { AgentGenerationModal } from "../AgentGenerationModal";
import { AgentImportModal } from "../AgentImportModal";
import { NewAgentDialog } from "../NewAgentDialog";
import { ArtifactImageViewer } from "../ArtifactImageViewer";
import { ArtifactsGallery } from "../ArtifactsGallery";
import { ModelOnboardingModal } from "../ModelOnboardingModal";
import { ReportModal } from "../ReportModal";
import { SetupWizardModal } from "../SetupWizardModal";
import { WorkflowAddStepModal } from "../WorkflowAddStepModal";

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
  return render(<ViewLayoutProvider projectId="project-window-dialogs">{ui}</ViewLayoutProvider>);
}

const noop = () => {};
const addToast = vi.fn();

const documentArtifact: ArtifactWithTask = {
  id: "doc-artifact",
  type: "document",
  title: "Document artifact",
  mimeType: "text/markdown",
  content: "# Document",
  authorId: "agent",
  authorType: "agent",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
} as ArtifactWithTask;

type WindowCase = {
  /** Inventory destination name. */
  name: string;
  /** Visible title the shared header must own. */
  title: RegExp;
  /** Mounts the real producer and reveals its chrome. */
  open: () => Promise<void> | void;
};

const CASES: WindowCase[] = [
  {
    name: "Agent generation",
    title: /Generate Agent/,
    open: () => { mount(<AgentGenerationModal isOpen onClose={noop} onGenerated={noop} projectId="p1" />); },
  },
  {
    name: "Agent import",
    title: /Import Agents/,
    open: () => { mount(<AgentImportModal isOpen onClose={noop} onImported={noop} projectId="p1" />); },
  },
  {
    name: "New agent",
    title: /New Agent/,
    open: () => { mount(<NewAgentDialog isOpen onClose={noop} onCreated={noop} projectId="p1" />); },
  },
  {
    name: "Artifact media viewer",
    title: /Screenshot artifact/,
    open: () => { mount(<ArtifactImageViewer artifactId="a-1" title="Screenshot artifact" projectId="p1" onClose={noop} />); },
  },
  {
    name: "Artifact document viewer",
    title: /Document artifact/,
    open: async () => {
      mount(
        <ArtifactsGallery
          artifacts={[documentArtifact]}
          projectId="p1"
          isMobile={false}
          addToast={addToast}
          onOpenTask={noop}
        />,
      );
      fireEvent.click(await screen.findByRole("button", { name: /Open Document artifact/ }));
    },
  },
  {
    name: "AI onboarding",
    title: /Set Up AI/,
    open: () => { mount(<ModelOnboardingModal onComplete={noop} addToast={addToast} projectId="p1" />); },
  },
  {
    name: "Report",
    title: /^Bug$/,
    open: () => { mount(<ReportModal actionType="bug" onClose={noop} />); },
  },
  {
    name: "First-run wizard",
    title: /Welcome to Fusion/,
    open: () => { mount(<SetupWizardModal onProjectRegistered={noop} onClose={noop} />); },
  },
  {
    name: "Add workflow step",
    title: /Add a step/,
    open: () => {
      mount(
        <WorkflowAddStepModal
          open
          onClose={noop}
          palette={[]}
          fragments={[]}
          stepTemplates={[]}
          pluginTemplates={[]}
          onPickPalette={noop}
          onPickFragment={noop}
          onPickStepTemplate={noop}
          onPickStepTemplateAsOptionalGroup={noop}
        />,
      );
    },
  },
];

function sharedHeaders(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".view-header"));
}

describe("FN-379 standardized window chrome", () => {
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

  for (const windowCase of CASES) {
    it.each(["desktop", "mobile"] as const)(`${windowCase.name} owns one shared header with its exit (%s)`, async (mode) => {
      setViewport(mode);
      await windowCase.open();

      await waitFor(() => expect(sharedHeaders().length).toBeGreaterThan(0));
      const headers = sharedHeaders();
      // One visual authority: no local title row survives beside the shared header.
      expect(headers).toHaveLength(1);
      const header = headers[0];
      expect(within(header).getByText(windowCase.title)).toBeInTheDocument();

      // The title is never repeated as a competing heading in the body.
      const surface = header.parentElement!;
      const competing = Array.from(surface.querySelectorAll("h1, h2, h3, h4"))
        .filter((node) => !header.contains(node))
        .map((node) => node.textContent?.trim() ?? "")
        .filter((text) => windowCase.title.test(text));
      expect(competing).toEqual([]);

      // Exactly one exit, built by the canonical primitive, inside the shared header.
      const closes = Array.from(document.querySelectorAll(".modal-close"));
      expect(closes).toHaveLength(1);
      expect(header.contains(closes[0])).toBe(true);
      expect(closes[0].getAttribute("aria-label")).toBeTruthy();
    });
  }

  /*
  The exit still reaches the owning host rather than merely existing: closing calls the surface's own handler once.
  */
  it("routes the shared header exit to the owning surface handler", async () => {
    const onClose = vi.fn();
    mount(<AgentGenerationModal isOpen onClose={onClose} onGenerated={noop} projectId="p1" />);
    const header = sharedHeaders()[0];
    fireEvent.click(header.querySelector<HTMLElement>(".modal-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /*
  The artifact viewers focus their close control on open; adopting the shared header must not cost that owner.
  */
  it("keeps the media viewer's opening focus on the canonical close control", async () => {
    mount(<ArtifactImageViewer artifactId="a-1" title="Screenshot artifact" projectId="p1" onClose={noop} />);
    const header = sharedHeaders()[0];
    const close = header.querySelector<HTMLElement>(".modal-close")!;
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  /*
  Onboarding's identity is per step: the shared header carries the step title and its optional badge, and the
  final step deliberately exposes no skip control.
  */
  it("keeps onboarding's step identity and skip control in the shared header", async () => {
    mount(<ModelOnboardingModal onComplete={noop} addToast={addToast} projectId="p1" />);
    const header = sharedHeaders()[0];
    expect(within(header).getByText(/Set Up AI/)).toBeInTheDocument();
    expect(within(header).getByText(/Optional/)).toBeInTheDocument();
    const skip = header.querySelector<HTMLElement>(".modal-close")!;
    expect(skip.getAttribute("aria-label")).toMatch(/Skip onboarding/);
  });

  /*
  Reporting keeps its stage flow: the header owns the surface title while later stages contribute content
  headings below it rather than a second chrome row.
  */
  it("keeps reporting's stage headings below the single shared header", async () => {
    mount(<ReportModal actionType="bug" onClose={noop} />);
    const header = sharedHeaders()[0];
    expect(within(header).getByText("Bug")).toBeInTheDocument();
    expect(screen.getByLabelText(/What went wrong\?/)).toBeInTheDocument();
    expect(sharedHeaders()).toHaveLength(1);
  });
});
