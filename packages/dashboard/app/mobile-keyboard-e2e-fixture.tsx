import { useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MobileDrawer } from "./components/MobileDrawer";
import { FloatingWindow } from "./components/FloatingWindow";
import { ViewLayoutProvider } from "./context/ViewLayoutContext";
/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
Stylesheet order mirrors `main.tsx`: component sheets (through the imports above) BEFORE `styles.css`,
`ui-style-tokens.css`, then `native-ui.css`. An inverted cascade would let a different rule win among
equal-specificity selectors than production does, which is exactly the class of drift a rendered
geometry test exists to catch.
*/
import "./styles.css";
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 rendered-geometry fixture. The reported defect is a RESULT: a field either under the soft
keyboard or separated from it by a large empty band. jsdom computes neither, which is why the
component tests can only prove published state and ownership.

This fixture mounts the REAL shared layout owners (`MobileDrawer`, `FloatingWindow`) with the real
stylesheets, then drives SIMULATED viewport metrics. It cannot raise a real keyboard, and nothing here
should be read as evidence of real iOS or Android behaviour; what it proves is that, given the exact
metric pairs those browsers publish, the rendered container edge and the rendered field land where they
must.

`__fn512Keyboard` reproduces the two shapes that matter:
  - `mode: "visual-only"` (WebKit): the layout viewport keeps its height, only the visual viewport
    shrinks. `100dvh` does NOT follow, which is precisely why the owner must measure and clamp.
  - `mode: "layout-resized"` (Android `interactive-widget=resizes-content`): both shrink together, so
    nothing is occluded and any reservation is dead space.
*/

interface KeyboardOverride {
  /**
   * Visible height to publish on `visualViewport`. The LAYOUT viewport is never faked: the test
   * resizes it for real through the Chrome DevTools Protocol, so `100dvh`, `position: fixed`, and
   * `documentElement.clientHeight` all behave exactly as the browser would make them.
   */
  visualHeight: number;
  offsetTop?: number;
}

declare global {
  interface Window {
    __fn512Keyboard: (override: KeyboardOverride) => void;
  }
}

function installKeyboardSimulation() {
  const bus = new EventTarget();

  /*
  Only the VISUAL viewport is faked. Chrome exposes no way to shrink it on demand, but the layout
  viewport can be resized for real through CDP — so the test drives that, and the two published
  shapes fall out naturally:

    - WebKit: layout viewport untouched, this fake height reduced → a real occluded band.
    - Android `resizes-content`: layout viewport resized via CDP AND this fake height matched to it
      → `documentElement.clientHeight` really is short, `100dvh` really follows, and the residual
      inset really is zero.
  */
  const fake = {
    get width() { return document.documentElement.clientWidth; },
    height: document.documentElement.clientHeight,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });

  // A genuine layout resize also changes the real viewport, so keep the fake height in step with it
  // whenever the test has not asked for an occluded band.
  window.addEventListener("resize", () => {
    if (fake.offsetTop === 0 && fake.height >= document.documentElement.clientHeight) {
      fake.height = document.documentElement.clientHeight;
    }
    bus.dispatchEvent(new Event("resize"));
  });

  window.__fn512Keyboard = ({ visualHeight, offsetTop = 0 }) => {
    fake.height = Math.min(visualHeight, document.documentElement.clientHeight);
    fake.offsetTop = offsetTop;
    bus.dispatchEvent(new Event("resize"));
    bus.dispatchEvent(new Event("scroll"));
  };
}

installKeyboardSimulation();

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "drawer";
const rows = Number.parseInt(params.get("rows") ?? "24", 10);

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
`--mobile-drawer-block-size` is scoped to `html[data-mobile-drawers="true"][data-viewport-mode="mobile"]`,
which App publishes on the root element. Without those attributes the token is undefined, the panel's
`height: var(--mobile-drawer-block-size)` is invalid, and the fixture would measure a content-sized
panel rather than the production one — a green result proving nothing about the real cascade.
*/
/*
FNXC:MobileKeyboardViewport 2026-09-17-15:32:
FN-512 remediation: `surface=window-drawer` is the PRODUCTION phone presentation of a FloatingWindow
(`resolveDrawerPresentation` requires the same two root attributes), which the earlier fixture never
exercised — `surface=window` only ever rendered an ordinary desktop-shaped floating window, so the
`!important` drawer sizing that defeats an inline height cap was untested.
*/
if (surface === "drawer" || surface === "window-drawer") {
  document.documentElement.dataset.mobileDrawers = "true";
  document.documentElement.dataset.viewportMode = "mobile";
}

void i18n.use(initReactI18next).init({
  lng: "fr",
  fallbackLng: "fr",
  resources: { fr: { translation: {} } },
  interpolation: { escapeValue: false },
});

/*
A long scrollable body with a PERSISTENT composer footer — the shape shared by Chat, the task
composers, and every long form in scope. The composer sits outside the scroller, exactly as in
production, so "is the field visible?" is a question about the container's bottom edge rather than
about how far the user happened to scroll.
*/
function HostedForm() {
  const [value, setValue] = useState("");
  return (
    <div className="fn512-surface" data-testid="fn512-surface">
      <div className="fn512-scroller" data-testid="fn512-scroller">
        {Array.from({ length: rows }, (_, index) => (
          <label className="fn512-form__row" key={index}>
            <span>Champ numéro {index}</span>
            <input className="input" type="text" defaultValue="" data-testid={`fn512-row-${index}`} />
          </label>
        ))}
      </div>
      <div className="fn512-composer" data-testid="fn512-composer">
        <textarea
          className="input"
          data-testid="fn512-field"
          aria-label="Composer"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={2}
        />
        <button type="button" className="btn btn-primary" data-testid="fn512-send">Envoyer</button>
      </div>
    </div>
  );
}

function Fixture() {
  if (surface === "window" || surface === "window-drawer") {
    return (
      <FloatingWindow
        windowKey="fn512-window"
        title="Nouvelle tâche"
        onClose={() => {}}
        defaultSize={{ width: 360, height: 700 }}
        defaultPosition={{ x: 10, y: 20 }}
      >
        <HostedForm />
      </FloatingWindow>
    );
  }
  return (
    <MobileDrawer open title="Conversation" onClose={() => {}} contentOwnsHeader contentOwnsScroll>
      <HostedForm />
    </MobileDrawer>
  );
}

const style = document.createElement("style");
style.textContent = `
  .fn512-surface { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  .fn512-scroller { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-md); }
  .fn512-form__row { display: flex; flex-direction: column; gap: var(--space-2xs); }
  .fn512-composer { flex: 0 0 auto; display: flex; gap: var(--space-sm); align-items: flex-end; padding: var(--space-md); }
  .fn512-composer .input { flex: 1; }
`;
document.head.append(style);

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <ViewLayoutProvider>
      <Fixture />
    </ViewLayoutProvider>
  </I18nextProvider>,
);
