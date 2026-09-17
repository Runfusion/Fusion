import { StrictMode, useState, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RootErrorBoundary } from "../components/ErrorBoundary";
import { FloatingWindow } from "../components/FloatingWindow";
import { MainContentDrawer } from "../components/dashboard/MainContent";
import { MobileDrawer, PlanningDrawer, ProjectsDrawer } from "../components/MobileDrawer";
import {
  DashboardWindowManagerProvider,
  DashboardWindowSurfaceRoot,
  useDashboardWindowVisibility,
} from "../context/DashboardWindowManagerContext";
import { UiDialog, UiDialogBackdrop } from "../components/ui/UiPrimitives";
import { installMobileKeyboardViewport, type MobileKeyboardViewportHarness } from "../test/mobileKeyboardViewport";

/*
FNXC:DashboardWindowSurfaceRefIdentity 2026-09-17-19:34:
FN-515 symptom verification for React #185 ("Maximum update depth exceeded") on modal open.

Original symptom (operator report): since a recent push, opening ANY modal replaced the app with the
minified React #185 overlay, especially on phones.

Proven chain (see the task `research` document; regression commit 4d7c0b3f2 / FN-512):
  inline `ref` callback re-created each render
  -> React detaches with null then re-attaches the same node
  -> useDashboardWindowSurface.publish runs twice with a CHANGED `root` both times
  -> upsertSurface bumps surfaceRevision twice
  -> the provider re-renders its consumers -> a new inline callback -> loop.

These cases therefore mount the REAL provider, the REAL primitives and the REAL error boundary. The
loop is never simulated with a thrown error and the registry is never mocked: a passing run means
React committed the open window without exceeding its nested-update budget.

jsdom performs no layout, so the metric pairs are supplied explicitly. These assertions cover
registry/state/identity behavior, not a rendered Safari or Android layout.
*/

const PHONE = { layoutHeight: 844, visualHeight: 844, visualWidth: 390 };
const NARROW_PHONE = { layoutHeight: 844, visualHeight: 844, visualWidth: 320 };
const PHONE_LANDSCAPE = { layoutHeight: 430, visualHeight: 430, visualWidth: 932 };
const TABLET = { layoutHeight: 1024, visualHeight: 1024, visualWidth: 768 };
const WIDE_TABLET = { layoutHeight: 1200, visualHeight: 1200, visualWidth: 900 };
const DESKTOP = { layoutHeight: 900, visualHeight: 900, visualWidth: 1280 };

let harness: MobileKeyboardViewportHarness | null = null;
/** React logs the update-depth error through console.error before the boundary renders. */
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

function consoleErrorText(): string {
  return (consoleErrorSpy?.mock.calls ?? [])
    .map((call) => call.map((part) => (part instanceof Error ? `${part.message}\n${part.stack ?? ""}` : String(part))).join(" "))
    .join("\n");
}

/** Fails loudly on the exact defect, whether React surfaced it as a throw or as a warning. */
function expectNoUpdateDepthError(): void {
  expect(consoleErrorText()).not.toMatch(/Maximum update depth exceeded|Minified React error #185|error #185/i);
  expect(screen.queryByText("Something went wrong")).toBeNull();
}

/** Reports the manager's live visible-surface count so registry churn is observable. */
function SurfaceCounter() {
  const visibility = useDashboardWindowVisibility();
  return <output data-testid="surface-count">{visibility?.visibleSurfaceCount ?? 0}</output>;
}

function Harness({ children }: { children: ReactNode }) {
  return (
    <RootErrorBoundary>
      <DashboardWindowManagerProvider>
        <SurfaceCounter />
        {children}
      </DashboardWindowManagerProvider>
    </RootErrorBoundary>
  );
}

/** Owner that starts CLOSED: the defect only fires once the managed root actually mounts. */
function OpenableFloatingWindow({
  windowKey = "repro-window",
  modal,
  keepMounted,
  body,
}: { windowKey?: string; modal?: boolean; keepMounted?: boolean; body?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open window</button>
      <button type="button" onClick={() => setOpen(false)}>Close window</button>
      {/* Re-renders the owner with brand-new handler identities, exactly like a parent state update. */}
      <button type="button" onClick={() => setTick((value) => value + 1)}>Nudge owner</button>
      <span data-testid="owner-tick">{tick}</span>
      {(open || keepMounted) && (
        <FloatingWindow
          windowKey={windowKey}
          title="Repro window"
          modal={modal}
          keepMounted={keepMounted}
          hidden={keepMounted ? !open : undefined}
          onClose={() => setOpen(false)}
        >
          {body ?? <input aria-label="Draft field" />}
        </FloatingWindow>
      )}
    </>
  );
}

function OpenableMobileDrawer({ title = "Repro drawer", keepMounted, body }: { title?: string; keepMounted?: boolean; body?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open drawer</button>
      <button type="button" onClick={() => setOpen(false)}>Close drawer</button>
      <button type="button" onClick={() => setTick((value) => value + 1)}>Nudge owner</button>
      <span data-testid="owner-tick">{tick}</span>
      <MobileDrawer
        open={open}
        title={title}
        keepMounted={keepMounted}
        onClose={() => setOpen(false)}
        testId="repro-drawer"
      >
        {body ?? <input aria-label="Draft field" />}
      </MobileDrawer>
    </>
  );
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = null;
  harness?.restore();
  harness = null;
});

describe.each([
  ["phone 390x844", PHONE],
  ["narrow phone 320", NARROW_PHONE],
  ["phone landscape 932x430", PHONE_LANDSCAPE],
  ["tablet 768", TABLET],
  ["wide tablet 900", WIDE_TABLET],
  ["desktop 1280x900", DESKTOP],
])("opening a managed window converges (%s)", (_label, metrics) => {
  it("FloatingWindow opens under the real window manager without exceeding the update depth", async () => {
    harness = installMobileKeyboardViewport(metrics);
    const user = userEvent.setup({ document });
    render(<Harness><OpenableFloatingWindow /></Harness>);

    expect(screen.getByTestId("surface-count")).toHaveTextContent("0");
    await user.click(screen.getByRole("button", { name: "Open window" }));

    expectNoUpdateDepthError();
    const field = screen.getByLabelText("Draft field");
    expect(field).toBeInTheDocument();
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");

    // Typing is the operator-visible proof: a remount-per-render would drop all but one character.
    await user.type(field, "abcdef");
    expect(field).toHaveValue("abcdef");
    expectNoUpdateDepthError();
  });

  it("MobileDrawer opens under the real window manager without exceeding the update depth", async () => {
    harness = installMobileKeyboardViewport(metrics);
    const user = userEvent.setup({ document });
    render(<Harness><OpenableMobileDrawer /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open drawer" }));

    expectNoUpdateDepthError();
    const field = screen.getByLabelText("Draft field");
    await user.type(field, "abcdef");
    expect(field).toHaveValue("abcdef");
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
    expectNoUpdateDepthError();
  });
});

describe("StrictMode double-invoked refs and effects converge too", () => {
  it("FloatingWindow", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    render(<StrictMode><Harness><OpenableFloatingWindow /></Harness></StrictMode>);

    await user.click(screen.getByRole("button", { name: "Open window" }));

    expectNoUpdateDepthError();
    expect(screen.getByLabelText("Draft field")).toBeInTheDocument();
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
  });

  it("MobileDrawer", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    render(<StrictMode><Harness><OpenableMobileDrawer /></Harness></StrictMode>);

    await user.click(screen.getByRole("button", { name: "Open drawer" }));

    expectNoUpdateDepthError();
    expect(screen.getByLabelText("Draft field")).toBeInTheDocument();
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
  });
});

describe("owner re-renders keep the same DOM element and its draft", () => {
  it.each([
    ["FloatingWindow", (props: { keepMounted?: boolean }) => <OpenableFloatingWindow {...props} />, "Open window", "Close window"],
    ["MobileDrawer", (props: { keepMounted?: boolean }) => <OpenableMobileDrawer {...props} />, "Open drawer", "Close drawer"],
  ] as const)("%s survives new handler identities", async (_name, renderOwner, openLabel, closeLabel) => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    render(<Harness>{renderOwner({})}</Harness>);

    await user.click(screen.getByRole("button", { name: openLabel }));
    const field = screen.getByLabelText("Draft field");
    await user.type(field, "draft");

    await user.click(screen.getByRole("button", { name: "Nudge owner" }));
    expect(screen.getByTestId("owner-tick")).toHaveTextContent("1");

    // Identity, not just value: a churned ref/remount would produce a different node.
    expect(screen.getByLabelText("Draft field")).toBe(field);
    expect(field).toHaveValue("draft");
    expectNoUpdateDepthError();

    await user.click(screen.getByRole("button", { name: closeLabel }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("0");

    await user.click(screen.getByRole("button", { name: openLabel }));
    expect(screen.getByLabelText("Draft field")).toBeInTheDocument();
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
    expectNoUpdateDepthError();
  });
});

describe("lifecycle orders around the registry", () => {
  it("two instances sharing one logical id count separately and closing one keeps the other", async () => {
    harness = installMobileKeyboardViewport(DESKTOP);
    const user = userEvent.setup({ document });
    function TwinOwners() {
      const [openA, setOpenA] = useState(false);
      const [openB, setOpenB] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpenA(true)}>Open A</button>
          <button type="button" onClick={() => setOpenB(true)}>Open B</button>
          <button type="button" onClick={() => setOpenA(false)}>Close A</button>
          {openA && <FloatingWindow windowKey="twin" title="Twin A" onClose={() => setOpenA(false)}><span>A body</span></FloatingWindow>}
          {openB && <FloatingWindow windowKey="twin" title="Twin B" onClose={() => setOpenB(false)}><span>B body</span></FloatingWindow>}
        </>
      );
    }
    render(<Harness><TwinOwners /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open A" }));
    await user.click(screen.getByRole("button", { name: "Open B" }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("2");

    await user.click(screen.getByRole("button", { name: "Close A" }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
    expect(screen.getByText("B body")).toBeInTheDocument();
    expectNoUpdateDepthError();
  });

  it("a closed keepMounted window is retained but counts zero visible surfaces", async () => {
    harness = installMobileKeyboardViewport(DESKTOP);
    const user = userEvent.setup({ document });
    render(<Harness><OpenableFloatingWindow keepMounted /></Harness>);

    expect(screen.getByTestId("surface-count")).toHaveTextContent("0");
    await user.click(screen.getByRole("button", { name: "Open window" }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
    await user.click(screen.getByRole("button", { name: "Close window" }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("0");
    expectNoUpdateDepthError();
  });

  it("full unmount releases every registration", async () => {
    harness = installMobileKeyboardViewport(DESKTOP);
    const user = userEvent.setup({ document });
    const view = render(<Harness><OpenableFloatingWindow /></Harness>);
    await user.click(screen.getByRole("button", { name: "Open window" }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");

    view.unmount();
    expect(document.querySelectorAll("[data-dashboard-window-surface]")).toHaveLength(0);
    expectNoUpdateDepthError();
  });

  it("a standalone mount with NO provider still opens (negative control)", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    render(<RootErrorBoundary><OpenableMobileDrawer /></RootErrorBoundary>);

    await user.click(screen.getByRole("button", { name: "Open drawer" }));

    expect(screen.getByLabelText("Draft field")).toBeInTheDocument();
    expectNoUpdateDepthError();
  });
});

describe("global hide/show keeps retained children, drafts and order", () => {
  it("hiding then restoring every surface preserves identity and draft", async () => {
    harness = installMobileKeyboardViewport(DESKTOP);
    const user = userEvent.setup({ document });
    function VisibilityHarness() {
      const visibility = useDashboardWindowVisibility();
      return (
        <>
          <button type="button" onClick={() => visibility?.toggleVisibility()}>Toggle visibility</button>
          <OpenableFloatingWindow />
        </>
      );
    }
    render(<Harness><VisibilityHarness /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open window" }));
    const field = screen.getByLabelText("Draft field");
    await user.type(field, "kept");

    await user.click(screen.getByRole("button", { name: "Toggle visibility" }));
    // Retained, not unmounted: the node survives the hide and counts as not visible.
    expect(screen.getByLabelText("Draft field")).toBe(field);
    expect(screen.getByTestId("surface-count")).toHaveTextContent("0");
    expectNoUpdateDepthError();

    await user.click(screen.getByRole("button", { name: "Toggle visibility" }));
    expect(screen.getByLabelText("Draft field")).toBe(field);
    expect(field).toHaveValue("kept");
    expect(screen.getByTestId("surface-count")).toHaveTextContent("1");
    expectNoUpdateDepthError();
  });

  it("opening a new window while hidden consumes the snapshot without a loop", async () => {
    harness = installMobileKeyboardViewport(DESKTOP);
    const user = userEvent.setup({ document });
    function VisibilityHarness() {
      const visibility = useDashboardWindowVisibility();
      const [openSecond, setOpenSecond] = useState(false);
      return (
        <>
          <button type="button" onClick={() => visibility?.toggleVisibility()}>Toggle visibility</button>
          <button type="button" onClick={() => setOpenSecond(true)}>Open second</button>
          <OpenableFloatingWindow windowKey="first-window" />
          {openSecond && (
            <FloatingWindow windowKey="second-window" title="Second" onClose={() => setOpenSecond(false)}>
              <span>Second body</span>
            </FloatingWindow>
          )}
        </>
      );
    }
    render(<Harness><VisibilityHarness /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open window" }));
    await user.click(screen.getByRole("button", { name: "Toggle visibility" }));
    expect(screen.getByTestId("surface-count")).toHaveTextContent("0");

    await user.click(screen.getByRole("button", { name: "Open second" }));

    expect(screen.getByText("Second body")).toBeInTheDocument();
    expect(screen.getByLabelText("Draft field")).toBeInTheDocument();
    expectNoUpdateDepthError();
  });
});

describe("production drawer bridges open under the real manager", () => {
  it.each([
    ["ProjectsDrawer", ProjectsDrawer],
    ["PlanningDrawer", PlanningDrawer],
  ] as const)("%s", async (_name, Bridge) => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    function BridgeOwner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open bridge</button>
          <Bridge open={open} title="Bridge" onClose={() => setOpen(false)}>
            <input aria-label="Draft field" />
          </Bridge>
        </>
      );
    }
    render(<Harness><BridgeOwner /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open bridge" }));

    const field = screen.getByLabelText("Draft field");
    await user.type(field, "xy");
    expect(field).toHaveValue("xy");
    expectNoUpdateDepthError();
  });

  it("MainContentDrawer", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    function BridgeOwner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open bridge</button>
          <MainContentDrawer taskView="notes" open={open} title="Notes" onClose={() => setOpen(false)}>
            <input aria-label="Draft field" />
          </MainContentDrawer>
        </>
      );
    }
    render(<Harness><BridgeOwner /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open bridge" }));

    expect(screen.getByLabelText("Draft field")).toBeInTheDocument();
    expectNoUpdateDepthError();
  });
});

describe("real production hosts and stable negative controls", () => {
  it("ConfirmDialog opens through the shared primitives and resolves", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const user = userEvent.setup({ document });
    const onConfirm = vi.fn();
    function ConfirmOwner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Ask</button>
          <ConfirmDialog
            isOpen={open}
            options={{ title: "Delete it?", message: "This cannot be undone.", confirmLabel: "Delete" }}
            onConfirm={() => { onConfirm(); setOpen(false); }}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Harness><ConfirmOwner /></Harness>);

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expectNoUpdateDepthError();
    const dialog = screen.getByText("This cannot be undone.").closest("[role=dialog]") as HTMLElement;
    expect(dialog).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expectNoUpdateDepthError();
  });

  it("DashboardWindowSurfaceRoot, UiDialog and UiDialogBackdrop remain convergent", async () => {
    harness = installMobileKeyboardViewport(DESKTOP);
    const user = userEvent.setup({ document });
    function Controls() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open controls</button>
          {open && (
            <>
              <DashboardWindowSurfaceRoot logicalId="surface-root-control" data-testid="surface-root-control">
                <span>Surface root body</span>
              </DashboardWindowSurfaceRoot>
              <UiDialog><span>Primitive body</span></UiDialog>
              <UiDialogBackdrop>
                <div><span>Backdrop body</span></div>
              </UiDialogBackdrop>
            </>
          )}
        </>
      );
    }
    render(<Harness><Controls /></Harness>);

    await user.click(screen.getByRole("button", { name: "Open controls" }));

    expect(screen.getByTestId("surface-root-control")).toBeInTheDocument();
    expect(screen.getByText("Primitive body")).toBeInTheDocument();
    expect(screen.getByText("Backdrop body")).toBeInTheDocument();
    expectNoUpdateDepthError();
  });
});
