import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// t() returns the provided fallback so we assert on stable English text.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import { DesktopLaunchGate } from "../DesktopLaunchGate";

type LocationStub = {
  protocol: string;
  href: string;
  search: string;
  port: string;
  replace: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};

function stubLocation(href: string): LocationStub {
  const u = new URL(href);
  const loc: LocationStub = {
    protocol: u.protocol,
    href,
    search: u.search,
    port: u.port,
    replace: vi.fn(),
    reload: vi.fn(),
  };
  Object.defineProperty(window, "location", { value: loc, writable: true, configurable: true });
  return loc;
}

function stubShell(state: unknown) {
  const shell = {
    getState: vi.fn(async () => state),
    setDesktopMode: vi.fn(async () => state),
    onResetDesktopModeRequest: vi.fn(() => () => undefined),
    resetDesktopMode: vi.fn(async () => undefined),
  };
  (window as unknown as { fusionShell: unknown }).fusionShell = shell;
  return shell;
}

const localReadyState = {
  host: "desktop-shell",
  desktopMode: "local",
  desktopModeState: { isFirstRun: false, desktopMode: "local" },
  localRuntime: { source: "embedded-local", state: "running", port: 50123, baseUrl: "http://127.0.0.1:50123" },
  profiles: [],
  activeProfileId: null,
};

describe("DesktopLaunchGate — local handoff", () => {
  afterEach(() => {
    delete (window as unknown as { fusionShell?: unknown }).fusionShell;
  });

  /*
   * Regression for "Can't reach the Fusion backend / Failed to fetch": on the packaged file:// page,
   * relative /api requests fail, so the gate must load the UI from the embedded runtime's own origin.
   */
  it("navigates to the runtime origin exactly once when loaded from file://", async () => {
    const location = stubLocation("file:///C:/app/index.html");
    stubShell(localReadyState);

    render(
      <DesktopLaunchGate>
        <div data-testid="app-loaded">app</div>
      </DesktopLaunchGate>,
    );

    await waitFor(() => expect(location.replace).toHaveBeenCalledTimes(1));
    const target = location.replace.mock.calls[0][0] as string;
    expect(target).toMatch(/^http:\/\/127\.0\.0\.1:50123\//);
    expect(target).toContain("shellMode=local");
  });

  /*
   * Regression for the reload loop ("rapid Starting Fusion flashing"): once the page is served over
   * http by the runtime, the gate must render the app and NOT navigate again.
   */
  it("renders the app (no navigation) when already served over http by the runtime", async () => {
    const location = stubLocation("http://127.0.0.1:50123/");
    const shell = stubShell(localReadyState);

    render(
      <DesktopLaunchGate>
        <div data-testid="app-loaded">app</div>
      </DesktopLaunchGate>,
    );

    await waitFor(() => expect(screen.getByTestId("app-loaded")).toBeTruthy());
    expect(location.replace).not.toHaveBeenCalled();
    expect(shell.setDesktopMode).not.toHaveBeenCalled();
  });

  it("starts the runtime when it is not running, then navigates to its origin", async () => {
    const location = stubLocation("file:///C:/app/index.html");
    // First getState: stopped. setDesktopMode starts it; subsequent polls: running.
    let started = false;
    const running = localReadyState;
    const stopped = { ...localReadyState, localRuntime: { source: "none", state: "stopped" } };
    const shell = {
      getState: vi.fn(async () => (started ? running : stopped)),
      setDesktopMode: vi.fn(async () => {
        started = true;
        return running;
      }),
      onResetDesktopModeRequest: vi.fn(() => () => undefined),
      resetDesktopMode: vi.fn(async () => undefined),
    };
    (window as unknown as { fusionShell: unknown }).fusionShell = shell;

    render(
      <DesktopLaunchGate>
        <div data-testid="app-loaded">app</div>
      </DesktopLaunchGate>,
    );

    await waitFor(() => expect(shell.setDesktopMode).toHaveBeenCalledWith("local"));
    await waitFor(() => expect(location.replace).toHaveBeenCalledTimes(1));
    expect(location.replace.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:50123\//);
  });
});
