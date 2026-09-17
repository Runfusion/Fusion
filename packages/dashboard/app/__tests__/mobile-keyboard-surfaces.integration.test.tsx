import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider } from "../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../components/FloatingWindow";
import { MobileDrawer } from "../components/MobileDrawer";
import { useKeyboardViewportOwnedByAncestor } from "../hooks/useKeyboardViewportSurface";
import {
  installMobileKeyboardViewport,
  stubBoundingRect,
  type MobileKeyboardViewportHarness,
} from "../test/mobileKeyboardViewport";
import { readAppFile } from "../test/cssFixture";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 symptom verification across real container owners, not helpers.

Original symptom (operator report): opening the soft keyboard on phone — the Chat especially — left
the field either UNDER the keyboard or separated from it by a large empty band, intermittently.

Reproduction driven here:
  (A) WebKit: layout stays 844, visual viewport drops to 500 (optionally with offsetTop 40).
  (B) Android resizes-content: layout AND visual drop to 500 together while innerHeight lags at 844.

Assertions: the owning container publishes exactly ONE bound matching the last coherent sample, a
descendant publishes none, and closing the keyboard restores the resting geometry.

jsdom does not lay anything out, so rectangles are supplied explicitly and these assertions cover
published state and ownership — they are not evidence of a rendered Safari layout.
*/

let harness: MobileKeyboardViewportHarness | null = null;

const PHONE = { layoutHeight: 844, visualHeight: 844, visualWidth: 390 };
const drawerCss = readAppFile("components/MobileDrawer.css");

/** Records whether a hosted descendant believes it may adapt its own geometry. */
function HostedContent({ onOwnership }: { onOwnership: (owned: boolean) => void }) {
  const owned = useKeyboardViewportOwnedByAncestor();
  onOwnership(owned);
  return (
    <div>
      <div style={{ height: "200vh" }}>Long content</div>
      <textarea aria-label="Composer" />
      <button type="button">Send</button>
    </div>
  );
}

function openDrawer(rect: { top: number; height: number }) {
  const ownership: boolean[] = [];
  const view = render(
    <MobileDrawer open title="Chat" onClose={() => {}}>
      <HostedContent onOwnership={(owned) => ownership.push(owned)} />
    </MobileDrawer>,
  );
  const panel = screen.getByRole("dialog", { name: "Chat" });
  const overlay = panel.parentElement as HTMLElement;
  stubBoundingRect(panel, rect);
  stubBoundingRect(overlay, rect);
  return { panel, overlay, ownership, unmount: view.unmount };
}

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe("MobileDrawer owns exactly one keyboard adaptation", () => {
  it("scenario A — bounds the panel to the visible area so the composer is not left under the keyboard", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay, ownership } = openDrawer({ top: 0, height: 844 });
    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    expect(overlay).toHaveClass("mobile-drawer--keyboard-bounded");
    expect(ownership.at(-1)).toBe(true);
  });

  it("scenario A — a positive offsetTop moves the bound, it does not add a second offset", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { panel, overlay } = openDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500, offsetTop: 40 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("304px");
  });

  it("scenario B — reserves NOTHING once the browser already resized the layout viewport", () => {
    harness = installMobileKeyboardViewport(PHONE);
    // The drawer follows the resized layout, so its own rectangle is already 500 tall.
    const { overlay, ownership } = openDrawer({ top: 0, height: 500 });

    harness.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500, visualWidth: 390 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expect(overlay).not.toHaveClass("mobile-drawer--keyboard-bounded");
    // No owner claim, so hosted content is free to adapt if it genuinely needs to — and, since
    // nothing is occluded, it will also find no overflow of its own.
    expect(ownership.at(-1)).toBe(false);
  });

  it("hosted content never receives permission to clamp a second time while the panel is bounded", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { ownership } = openDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });
    harness.set({ ...PHONE, visualHeight: 420 });

    expect(ownership.at(-1)).toBe(true);
  });

  it("scenario C — close then reopen restores the resting geometry with no residual bound", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { panel, overlay } = openDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });
    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");

    harness.set(PHONE);
    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");

    harness.set({ ...PHONE, visualHeight: 500 });
    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");

    harness.set(PHONE);
    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expect(overlay).not.toHaveClass("mobile-drawer--keyboard-bounded");
  });

  it("matches the last coherent sample and ignores the impossible one in between", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { panel, overlay } = openDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });
    // WebKit transitional sample: offsetTop from the transition, height not yet updated.
    harness.set({ layoutHeight: 500, visualHeight: 844, offsetTop: 40, visualWidth: 390 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
  });

  it("keeps the composer and its Send action reachable inside the bounded panel", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { panel, overlay } = openDrawer({ top: 0, height: 844 });
    harness.set({ ...PHONE, visualHeight: 500 });

    const composer = screen.getByLabelText("Composer");
    await userEvent.type(composer, "bonjour");

    expect(panel.contains(composer)).toBe(true);
    expect(panel.contains(screen.getByRole("button", { name: "Send" }))).toBe(true);
    expect(composer).toHaveValue("bonjour");
    expect(document.activeElement).toBe(composer);
  });

  it("preserves a multi-line draft and the focused field across a keyboard cycle", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    openDrawer({ top: 0, height: 844 });
    const composer = screen.getByLabelText("Composer") as HTMLTextAreaElement;
    await userEvent.type(composer, "ligne un{Shift>}{Enter}{/Shift}ligne deux");

    harness.set({ ...PHONE, visualHeight: 500 });
    harness.set(PHONE);

    expect(composer).toHaveValue("ligne un\nligne deux");
    expect(screen.getByLabelText("Composer")).toBe(composer);
  });

  it("does not adapt a retained drawer that is closed", () => {
    harness = installMobileKeyboardViewport(PHONE);
    render(
      <MobileDrawer open={false} keepMounted title="Chat" onClose={() => {}}>
        <HostedContent onOwnership={() => {}} />
      </MobileDrawer>,
    );
    const retainedPanel = document.querySelector(".mobile-drawer__panel") as HTMLElement;
    const retainedOverlay = retainedPanel.parentElement as HTMLElement;
    stubBoundingRect(retainedPanel, { top: 0, height: 844 });
    stubBoundingRect(retainedOverlay, { top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(retainedOverlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expect(retainedOverlay).not.toHaveClass("mobile-drawer--keyboard-bounded");
  });

  it("stops adapting a panel that unmounted mid transition", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay, unmount } = openDrawer({ top: 0, height: 844 });
    harness.set({ ...PHONE, visualHeight: 500 });

    unmount();
    harness.set({ ...PHONE, visualHeight: 300 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
  });
});

/*
FNXC:MobileKeyboardViewport 2026-09-17-15:32:
FN-512 remediation: on a phone, a FloatingWindow is re-presented as a drawer whose height and
max-height are `!important`, so the inline height cap the window published was inert — yet the window
still declared ownership, so hosted Chat and forms stood down and the field stayed under the keyboard.
The drawer presentation now adapts the OVERLAY's bottom edge like MobileDrawer, and ownership is only
claimed when an adaptation is really applied.
*/
describe("FloatingWindow phone drawer presentation owns exactly one adaptation", () => {
  function setPhoneDrawerViewport() {
    document.documentElement.dataset.mobileDrawers = "true";
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  }

  function openWindow(rect: { top: number; height: number }) {
    const ownership: boolean[] = [];
    render(
      <FloatingWindow windowKey="fn512-form" title="Nouvelle tâche" onClose={() => {}}>
        <HostedContent onOwnership={(owned) => ownership.push(owned)} />
      </FloatingWindow>,
    );
    const panel = screen.getByTestId("floating-window-fn512-form");
    const overlay = screen.getByTestId("floating-window-overlay-fn512-form");
    stubBoundingRect(panel, rect);
    stubBoundingRect(overlay, rect);
    return { panel, overlay, ownership };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.mobileDrawers;
  });

  it("pulls the drawer overlay's bottom edge up instead of publishing an inert inline cap", () => {
    setPhoneDrawerViewport();
    harness = installMobileKeyboardViewport(PHONE);
    const { panel, overlay, ownership } = openWindow({ top: 0, height: 844 });
    expect(panel).toHaveClass("floating-window--mobile-drawer");

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    expect(overlay).toHaveClass("floating-window-overlay--keyboard-bounded");
    // The inert inline cap is gone: the drawer presentation is sized by the overlay alone.
    expect(panel.style.maxHeight).toBe("");
    expect(ownership.at(-1)).toBe(true);
  });

  it("claims no ownership while nothing is occluded, so hosted content keeps its own freedom", () => {
    setPhoneDrawerViewport();
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay, ownership } = openWindow({ top: 0, height: 500 });

    harness.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500, visualWidth: 390 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expect(overlay).not.toHaveClass("floating-window-overlay--keyboard-bounded");
    expect(ownership.at(-1)).toBe(false);
  });

  it("restores the resting overlay geometry when the keyboard closes", () => {
    setPhoneDrawerViewport();
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay } = openWindow({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });
    harness.set(PHONE);

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expect(overlay).not.toHaveClass("floating-window-overlay--keyboard-bounded");
  });

  it("keeps capping an ordinary desktop-shaped window, which has no !important drawer sizing", () => {
    harness = installMobileKeyboardViewport({ layoutHeight: 900, visualHeight: 900, visualWidth: 1280 });
    const { panel, overlay } = openWindow({ top: 20, height: 700 });

    harness.set({ layoutHeight: 900, visualHeight: 500, visualWidth: 1280 });

    expect(panel.style.maxHeight).toBe("480px");
    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
  });
});

/*
FNXC:DashboardWindowSurfaceRefIdentity 2026-09-17-19:34:
FN-515: every case above mounts the containers WITHOUT the window manager, so `upsertSurface` is
undefined, publication is a no-op, and a churning root ref sets no state — which is exactly why this
file could not see the React #185 loop FN-512 introduced. These cases re-run the same keyboard orders
under the REAL provider, so the keyboard adaptation and the surface registry are exercised together.
*/
describe("keyboard adaptation under the real window manager", () => {
  function renderManaged(node: ReactNode) {
    return render(<DashboardWindowManagerProvider>{node}</DashboardWindowManagerProvider>);
  }

  function openManagedDrawer(rect: { top: number; height: number }) {
    const view = renderManaged(
      <MobileDrawer open title="Chat" onClose={() => {}}>
        <HostedContent onOwnership={() => {}} />
      </MobileDrawer>,
    );
    const panel = screen.getByRole("dialog", { name: "Chat" });
    const overlay = panel.parentElement as HTMLElement;
    stubBoundingRect(panel, rect);
    stubBoundingRect(overlay, rect);
    return { panel, overlay, unmount: view.unmount };
  }

  /** The loop surfaced through React's own console.error before any boundary could render. */
  function expectNoUpdateDepthError(spy: ReturnType<typeof vi.spyOn>) {
    const text = spy.mock.calls
      .map((call) => call.map((part) => (part instanceof Error ? part.message : String(part))).join(" "))
      .join("\n");
    expect(text).not.toMatch(/Maximum update depth exceeded|error #185/i);
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("scenario A — one bound, no update-depth loop, composer still usable", async () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay } = openManagedDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    const composer = screen.getByLabelText("Composer");
    await userEvent.type(composer, "bonjour");
    expect(composer).toHaveValue("bonjour");
    expect(screen.getByLabelText("Composer")).toBe(composer);
    expectNoUpdateDepthError(errorSpy);
  });

  it("scenario A — offsetTop 40 moves the bound, not a second offset", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay } = openManagedDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500, offsetTop: 40 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("304px");
    expectNoUpdateDepthError(errorSpy);
  });

  it("scenario B — an already-resized layout reserves nothing", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay } = openManagedDrawer({ top: 0, height: 500 });

    harness.set({ layoutHeight: 500, innerHeight: 844, visualHeight: 500, visualWidth: 390 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expectNoUpdateDepthError(errorSpy);
  });

  it("a duplicate identical frame publishes the same bound once more, with no loop", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { overlay } = openManagedDrawer({ top: 0, height: 844 });

    harness.set({ ...PHONE, visualHeight: 500 });
    harness.set({ ...PHONE, visualHeight: 500 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    expectNoUpdateDepthError(errorSpy);
  });

  it("focus then resize, and resize then focus, both settle on the same bound", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const first = openManagedDrawer({ top: 0, height: 844 });
    harness.emitFocusIn();
    harness.set({ ...PHONE, visualHeight: 500 });
    expect(first.overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    first.unmount();

    harness.restore();
    harness = installMobileKeyboardViewport(PHONE);
    const second = openManagedDrawer({ top: 0, height: 844 });
    harness.set({ ...PHONE, visualHeight: 500 });
    harness.emitFocusIn();
    expect(second.overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    expectNoUpdateDepthError(errorSpy);
  });

  it("mounting with the keyboard already open adapts on the first coherent event", () => {
    harness = installMobileKeyboardViewport(PHONE);
    harness.setSilently({ ...PHONE, visualHeight: 500 });
    const { overlay } = openManagedDrawer({ top: 0, height: 844 });

    harness.emitResize();

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("344px");
    expectNoUpdateDepthError(errorSpy);
  });

  it("a viewport event after unmount neither revives a surface nor loops", () => {
    harness = installMobileKeyboardViewport(PHONE);
    const { unmount } = openManagedDrawer({ top: 0, height: 844 });
    harness.set({ ...PHONE, visualHeight: 500 });

    unmount();
    harness.set({ ...PHONE, visualHeight: 300 });

    expect(document.querySelectorAll("[data-dashboard-window-surface]")).toHaveLength(0);
    expectNoUpdateDepthError(errorSpy);
  });

  it("a browser with no Visual Viewport API adapts nothing and still converges", () => {
    harness = installMobileKeyboardViewport(PHONE);
    harness.removeVisualViewport();
    const { overlay } = openManagedDrawer({ top: 0, height: 844 });

    expect(overlay.style.getPropertyValue("--mobile-drawer-keyboard-inset")).toBe("");
    expectNoUpdateDepthError(errorSpy);
  });
});

describe("FloatingWindow drawer CSS contract", () => {
  const floatingWindowCss = readAppFile("components/FloatingWindow.css");

  it("adapts the drawer overlay's bottom edge and lets the panel fill it", () => {
    expect(floatingWindowCss).toMatch(
      /\.floating-window-overlay--mobile-drawer\.floating-window-overlay--keyboard-bounded\s*\{[^}]*bottom: var\(--mobile-drawer-keyboard-inset, 0px\)/,
    );
    expect(floatingWindowCss).toMatch(
      /\.floating-window-overlay--keyboard-bounded \.floating-window--mobile-drawer\s*\{[^}]*height: 100% !important/,
    );
    expect(floatingWindowCss).toMatch(
      /\.floating-window-overlay--keyboard-bounded \.floating-window--mobile-drawer\s*\{[^}]*max-height: 100% !important/,
    );
  });
});

describe("drawer CSS contract", () => {
  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  The adaptation belongs to the OVERLAY, which is `position: fixed; inset: 0` and bottom-aligns its
  panel. Pulling its bottom edge up by the residual inset moves the whole drawer into the visible area
  in one step. Capping the panel's height instead is unstable, because shortening a bottom-aligned box
  moves its own top; measured in Chromium that collapsed the panel from 832px to 144px to 1px.
  */
  it("pulls the overlay's bottom edge up by the residual inset, with no inset at rest", () => {
    expect(drawerCss).toMatch(
      /\.mobile-drawer--keyboard-bounded\s*\{[^}]*bottom: var\(--mobile-drawer-keyboard-inset, 0px\)/,
    );
    expect(drawerCss).toMatch(
      /\.mobile-drawer--keyboard-bounded \.mobile-drawer__panel\s*\{[^}]*height: 100%/,
    );
  });

  it("drops the navigation/system reserve only while the panel is keyboard-bounded", () => {
    expect(drawerCss).toMatch(
      /\.mobile-drawer__panel--keyboard-bounded \.mobile-drawer__body\s*\{[^}]*padding-block-end: 0/,
    );
    // The resting reserve is untouched, so safe-area and standalone clearance still apply.
    expect(drawerCss).toMatch(
      /\.mobile-drawer__body\s*\{[^}]*padding-block-end: var\(--mobile-nav-system-offset\)/,
    );
  });

  it("leaves the resting panel size derived from the shared drawer token", () => {
    expect(drawerCss).toMatch(/\.mobile-drawer__panel\s*\{[^}]*height: var\(--mobile-drawer-block-size\)/);
  });
});
