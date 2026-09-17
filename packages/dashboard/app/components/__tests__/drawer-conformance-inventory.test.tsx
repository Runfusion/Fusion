import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";
import { ViewDrawerHandle } from "../ViewDrawer";
import { FloatingWindow } from "../FloatingWindow";
import { MobileDrawer } from "../MobileDrawer";
import { ModalCloseButton } from "../ModalCloseButton";
import { HideInDrawer, useDrawerPresentation } from "../ViewDrawer";
import { ViewBackButton } from "../ViewActionButton";
import { ViewHeader } from "../ViewHeader";

/*
FNXC:StandardizedDrawers 2026-09-15-04:56:
FN-406: a phone drawer exposes exactly one shared ViewDrawerHandle and no close control. Before this suite the
predicate was duplicated per host and each surface invented its own grab bar, which is how the file browser ended up
with two handles and an X. These cases pin the shared context contract; the ratchets below stop a new bespoke handle
or an unguarded drawer close from reappearing.
*/

const originalWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setViewport(mode: "mobile" | "desktop", { drawers = true }: { drawers?: boolean } = {}) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query.includes("max-width") || query.includes("max-height")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  document.documentElement.dataset.viewportMode = mode;
  if (mode === "mobile" && drawers) document.documentElement.dataset.mobileDrawers = "true";
  else delete document.documentElement.dataset.mobileDrawers;
}

function PresentationProbe() {
  return <span data-testid="presentation">{String(useDrawerPresentation())}</span>;
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  delete document.documentElement.dataset.mobileDrawers;
  delete document.documentElement.dataset.viewportMode;
});

describe("shared drawer presentation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes false for a desktop floating window", () => {
    setViewport("desktop");
    render(
      <FloatingWindow windowKey="probe-desktop" title="Probe" onClose={() => {}}>
        <PresentationProbe />
      </FloatingWindow>,
    );
    expect(screen.getByTestId("presentation")).toHaveTextContent("false");
  });

  it("publishes true for a phone floating window with the drawer opt-in", () => {
    setViewport("mobile");
    render(
      <FloatingWindow windowKey="probe-drawer" title="Probe" onClose={() => {}}>
        <PresentationProbe />
      </FloatingWindow>,
    );
    expect(screen.getByTestId("presentation")).toHaveTextContent("true");
  });

  it("publishes false on a phone without the data-mobile-drawers opt-in", () => {
    setViewport("mobile", { drawers: false });
    render(
      <FloatingWindow windowKey="probe-no-optin" title="Probe" onClose={() => {}}>
        <PresentationProbe />
      </FloatingWindow>,
    );
    expect(screen.getByTestId("presentation")).toHaveTextContent("false");
  });

  it("publishes false for an excluded confirmation window on a phone", () => {
    setViewport("mobile");
    render(
      <FloatingWindow windowKey="probe-confirm" title="Probe" onClose={() => {}} className="floating-window--confirm">
        <PresentationProbe />
      </FloatingWindow>,
    );
    expect(screen.getByTestId("presentation")).toHaveTextContent("false");
  });

  it("publishes true inside MobileDrawer, which is a drawer by construction", () => {
    setViewport("mobile");
    render(
      <MobileDrawer open title="Probe" onClose={() => {}}>
        <PresentationProbe />
      </MobileDrawer>,
    );
    expect(screen.getByTestId("presentation")).toHaveTextContent("true");
  });
});

function HostedHeader({ withActions = false }: { withActions?: boolean }) {
  return (
    <ViewHeader
      title="Hosted view"
      onClose={() => {}}
      backAction={{ label: "Back to list", onClick: () => {} }}
      actions={withActions ? <button type="button">Refresh</button> : undefined}
    />
  );
}

function HostedOwnClose() {
  return (
    <HideInDrawer>
      <ModalCloseButton onClick={() => {}} aria-label="Close hosted view" />
    </HideInDrawer>
  );
}

describe("drawer chrome conformance across hosts", () => {
  it.each([
    ["canonical ViewHeader close", <HostedHeader key="a" />],
    ["host-owned close wrapped in HideInDrawer", <HostedOwnClose key="b" />],
  ])("removes the %s in phone drawer presentation", (_label, content) => {
    setViewport("mobile");
    render(
      <FloatingWindow windowKey="chrome-drawer" title="Host" onClose={() => {}} hideHeader>
        {content}
      </FloatingWindow>,
    );
    expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
  });

  it.each([
    ["desktop", "desktop" as const, true],
    ["a phone without the drawer opt-in", "mobile" as const, false],
  ])("keeps both closes on %s", (_label, mode, drawers) => {
    setViewport(mode, { drawers });
    render(
      <FloatingWindow windowKey="chrome-window" title="Host" onClose={() => {}} hideHeader>
        <HostedHeader />
        <HostedOwnClose />
      </FloatingWindow>,
    );
    expect(screen.getAllByRole("button", { name: /close/i })).toHaveLength(2);
  });

  it("keeps the close on an excluded confirmation window shown on a phone", () => {
    setViewport("mobile");
    render(
      <FloatingWindow windowKey="chrome-confirm" title="Host" onClose={() => {}} hideHeader className="floating-window--confirm">
        <HostedHeader />
        <HostedOwnClose />
      </FloatingWindow>,
    );
    expect(screen.getAllByRole("button", { name: /close/i })).toHaveLength(2);
  });

  it("keeps the back affordance and drops the empty actions shell when the close was its only child", () => {
    setViewport("mobile");
    const { container } = render(
      <FloatingWindow windowKey="chrome-back" title="Host" onClose={() => {}} hideHeader>
        <HostedHeader />
      </FloatingWindow>,
    );
    expect(screen.getByRole("button", { name: "Back to list" })).toBeInTheDocument();
    expect(container.ownerDocument.querySelector(".view-header__actions")).toBeNull();
  });

  /*
  FNXC:StandardizedDrawers 2026-09-15-16:33:
  FN-427: a back control whose only effect is to dismiss the surface is drawer chrome wearing a navigation costume —
  the handle, scrim and Escape already dismiss it. Suppression goes through the same seam as the close (HideInDrawer /
  useDrawerPresentation); a back that performs a real internal navigation must survive untouched.
  */
  it("removes a dismiss-only back control in drawer presentation while keeping internal navigation", () => {
    setViewport("mobile");
    render(
      <FloatingWindow windowKey="chrome-dismiss-back" title="Host" onClose={() => {}} hideHeader>
        <HideInDrawer>
          <ViewBackButton label="Back" onClick={() => {}} />
        </HideInDrawer>
        <HostedHeader />
      </FloatingWindow>,
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
  });

  it("keeps a dismiss-only back control on a phone without the drawer opt-in", () => {
    setViewport("mobile", { drawers: false });
    render(
      <FloatingWindow windowKey="chrome-dismiss-back-no-optin" title="Host" onClose={() => {}} hideHeader>
        <HideInDrawer>
          <ViewBackButton label="Back" onClick={() => {}} />
        </HideInDrawer>
      </FloatingWindow>,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("keeps a non-close action row rendered in drawer presentation", () => {
    setViewport("mobile");
    render(
      <FloatingWindow windowKey="chrome-actions" title="Host" onClose={() => {}} hideHeader>
        <HostedHeader withActions />
      </FloatingWindow>,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
    expect(document.querySelector(".view-header__actions")).not.toBeNull();
  });
});

/*
FNXC:StandardizedDrawers 2026-09-15-04:56:
FN-406 ratchets. These assert CODE CONSTRUCTS, never comments. (a) no component stylesheet may paint its own grab bar
in a phone media block — that drift is exactly what stacked a second handle on the file browser; (b) every production
close control must either live in the shared ViewHeader, be guarded by the single drawer-presentation seam, or appear
in a named exemption with its reason.
*/

/**
 * Desktop and tablet pointer grips are not drawer handles: they belong to pointer resizing or window detaching, are
 * unreachable on phones, and are listed here so a future move into a phone media block is a deliberate decision
 * rather than a silent pass.
 *
 * FN-434 removed the pinned terminal's two resize grips (the panel is a fixed height now) and replaced them with a
 * single DETACH grip on the pinned panel's top edge: dragging it pulls the terminal out into a floating window. It is
 * rendered only in the non-mobile pinned presentation, so it is never phone drawer chrome.
 */
const RESIZE_GRIP_EXEMPTIONS = [
  ".terminal-below-drag-handle::before",
  ".mailbox-split-resize-handle::before",
  ".terminal-header__drag-grip::before",
] as const;

/**
 * TaskDetailModal guards its two closes with `isPhonePresentation` (viewport === "mobile"), a DELIBERATELY BROADER
 * contract than drawer presentation: it hides the close on every phone host, drawer or not. Re-keying it onto
 * `useDrawerPresentation()` would regress that contract on a phone without `data-mobile-drawers`.
 * FN-427 re-keys only the BACK control onto `useDrawerPresentation()` (a back wired to dismissal is duplicated drawer
 * chrome), so the file now reads the seam; the close guards above stay on the broader phone predicate and this
 * exemption remains the record of that deliberate asymmetry.
 */
const CLOSE_GUARD_EXEMPTIONS: readonly string[] = ["TaskDetailModal.tsx"];

const DRAWER_PRESENTATION_GUARDS = ["HideInDrawer", "useDrawerPresentation", "resolveDrawerPresentation"] as const;

/**
 * FN-427 back-affordance census. Every production component that renders a detail return is listed here with the
 * internal navigation it performs, so a NEW call site cannot appear without a deliberate classification. A return is
 * legitimate only when it navigates within the surface (list -> detail, detail -> list); a return whose only effect is
 * to dismiss the surface must go through the drawer-presentation seam instead, as TaskDetailModal now does.
 */
const BACK_AFFORDANCE_INVENTORY: readonly string[] = [
  "AgentDetailView.tsx", // agent detail sections -> agent overview
  "AgentsView.tsx", // agent detail -> agent list
  "ChatView.tsx", // conversation -> conversation list
  "EvalsView.tsx", // eval run -> eval list
  "FileBrowserModal.tsx", // file editor -> file list
  "GoalsView.tsx", // goal detail -> goal list
  "MailboxModal.tsx", // message -> mailbox list
  "MailboxView.tsx", // message -> mailbox list
  "MissionManager.tsx", // mission detail -> mission list
  "NodesView.tsx", // focused node -> node graph
  "NotesView.tsx", // note editor -> note list
  "PlanningModeModal.tsx", // history/session detail -> planning composer
  "PluginManager.tsx", // plugin detail -> plugin list
  "PullRequestView.tsx", // pull request detail -> pull request list
  "ScheduledTasksModal.tsx", // schedule form -> schedule list
  "ScriptsModal.tsx", // script form -> script list
  "SkillsView.tsx", // skill detail -> skill list
  "TaskDetailModal.tsx", // FN-427: no internal navigation; the phone back is re-keyed on drawer presentation
  "ViewHeader.tsx", // shared header primitive that renders every hosted backAction
  "WhiteboardView.tsx", // board detail -> board list
  "WorkflowNodeEditor.tsx", // node inspector -> workflow canvas
  // FN-508 removed the Dashboard's phone back: its sections are now chosen from a full-width drop list under a
  // fixed "Dashboard" header, so command-center/CommandCenter.tsx renders no back affordance at all.
  "command-center/IdeationPanel.tsx", // candidate detail -> candidate list
];

function phoneMediaBlocks(css: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css)) !== null) {
    let index = match.index + match[0].length;
    const start = index;
    let depth = 1;
    while (depth > 0 && index < css.length) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(css.slice(start, index - 1));
  }
  return blocks.join("\n");
}

function productionSource(file: string): string {
  return readAppFile(`components/${file}`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("drawer conformance ratchets", () => {
  it("keeps every drawer grab bar on the shared ViewDrawer primitive", () => {
    const bespoke = listComponentFiles()
      .filter((file) => file.endsWith(".css") && file !== "ViewDrawer.css")
      .flatMap((file) => {
        const phoneCss = phoneMediaBlocks(readAppFile(`components/${file}`));
        return [...phoneCss.matchAll(/([^{}]*::(?:before|after))\s*\{([^}]*)\}/g)]
          .filter(([, , body]) => /border-radius/.test(body) && /background/.test(body)
            && /(?:^|[\s;])(?:width|height|inline-size|block-size)\s*:/.test(body))
          .map(([, selector]) => `${file} ${selector.trim().replace(/\s+/g, " ")}`);
      })
      .filter((entry) => !RESIZE_GRIP_EXEMPTIONS.some((exempt) => entry.endsWith(exempt)));

    expect(bespoke).toEqual([]);
  });

  it.each([".file-browser-modal-header::before", ".mobile-more-sheet-handle::after"])(
    "never reintroduces the removed bespoke handle %s",
    (selector) => {
      const offenders = listComponentFiles()
        .filter((file) => file.endsWith(".css"))
        .filter((file) => readAppFile(`components/${file}`).includes(selector));
      expect(offenders).toEqual([]);
    },
  );

  it("guards every production close control by the shared header or the drawer presentation seam", () => {
    const unguarded = listComponentFiles()
      .filter((file) => file.endsWith(".tsx") && !file.startsWith("__tests__/"))
      .filter((file) => file !== "ModalCloseButton.tsx" && file !== "ViewHeader.tsx")
      .filter((file) => !CLOSE_GUARD_EXEMPTIONS.includes(file))
      .filter((file) => {
        const source = productionSource(file);
        if (!source.includes("<ModalCloseButton")) return false;
        return !DRAWER_PRESENTATION_GUARDS.some((guard) => source.includes(guard));
      });

    expect(unguarded).toEqual([]);
  });

  it("keeps every production back affordance in the classified census", () => {
    const callSites = listComponentFiles()
      .filter((file) => !file.startsWith("__tests__/") && !file.includes("/__tests__/"))
      .filter((file) => {
        const source = productionSource(file);
        return source.includes("backAction=") || source.includes("<ViewBackButton");
      })
      .sort();

    expect(callSites).toEqual([...BACK_AFFORDANCE_INVENTORY].sort());
  });

  it("keys the Task Detail back affordance on the shared drawer presentation seam", () => {
    const source = productionSource("TaskDetailModal.tsx");
    expect(source).toContain("useDrawerPresentation");
    expect(source).toMatch(/isPhonePresentation\s*&&\s*!drawerPresentation/);
  });

  it("resolves the More sheet drag target from the shared handle's inner bar", () => {
    const { container } = render(
      <ViewDrawerHandle className="mobile-more-sheet-handle" barClassName="mobile-more-sheet-handle__bar" />,
    );
    const bar = container.querySelector(".mobile-more-sheet-handle__bar")!;

    expect(bar.closest(".mobile-more-sheet-handle")).toBe(container.querySelector(".view-drawer__handle-target"));
  });
});
