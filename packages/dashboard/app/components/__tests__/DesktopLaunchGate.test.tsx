import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  /*
   * FNXC:MigrationHoldingPage 2026-07-17-13:45:
   * While localRuntime reports state "starting" with migration progress, the gate
   * must show the migration copy + the structured progress label instead of the
   * static "Starting local Fusion runtime…", then still hand off once running.
   */
  it("shows live migration progress while starting, then navigates when running", async () => {
    const location = stubLocation("file:///C:/app/index.html");
    let migrationDone = false;
    const migrating = {
      ...localReadyState,
      localRuntime: {
        source: "embedded-local",
        state: "starting",
        migration: { active: true, phase: "table-progress", label: "[3/12] project.tasks — 500/2000 rows" },
      },
    };
    const shell = {
      getState: vi.fn(async () => (migrationDone ? localReadyState : migrating)),
      setDesktopMode: vi.fn(async () => migrating),
      onResetDesktopModeRequest: vi.fn(() => () => undefined),
      resetDesktopMode: vi.fn(async () => undefined),
    };
    (window as unknown as { fusionShell: unknown }).fusionShell = shell;

    render(
      <DesktopLaunchGate>
        <div data-testid="app-loaded">app</div>
      </DesktopLaunchGate>,
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Database migration in progress"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("[3/12] project.tasks — 500/2000 rows");

    migrationDone = true;
    await waitFor(() => expect(location.replace).toHaveBeenCalledTimes(1));
    expect(location.replace.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:50123\//);
  });

  it("renders a copyable structured failure panel for local runtime errors", async () => {
    stubLocation("file:///C:/app/index.html");
    const failure = {
      phase: "create-store" as const, attempts: 1, name: "Error", message: "boom", stack: "Error: boom\n at start",
      logPath: "/tmp/.fusion/logs/desktop-startup.log", platform: "linux", nodeVersion: "22", occurredAt: "2026-09-08T00:00:00.000Z",
    };
    const errorState = { ...localReadyState, localRuntime: { source: "embedded-local", state: "error", error: "boom", startupFailure: failure } };
    stubShell(errorState);

    render(<DesktopLaunchGate><div>app</div></DesktopLaunchGate>);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Startup phase: create-store"));
    expect(screen.getByText("Show technical details")).toBeTruthy();
    expect(screen.getByText(/desktop-startup\.log/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
  });

  it("keeps structured diagnostics after remembered-local startup rejects", async () => {
    stubLocation("file:///C:/app/index.html");
    const failure = {
      phase: "create-store" as const, attempts: 1, name: "Error", message: "boom", stack: "Error: boom",
      platform: "linux", nodeVersion: "22", occurredAt: "2026-09-08T00:00:00.000Z",
    };
    const stopped = { ...localReadyState, localRuntime: { source: "none", state: "stopped" } };
    const failed = { ...localReadyState, localRuntime: { source: "embedded-local", state: "error", error: "boom", startupFailure: failure } };
    let attempted = false;
    const shell = {
      getState: vi.fn(async () => (attempted ? failed : stopped)),
      setDesktopMode: vi.fn(async () => { attempted = true; throw new Error("boom"); }),
      onResetDesktopModeRequest: vi.fn(() => () => undefined),
      resetDesktopMode: vi.fn(async () => undefined),
    };
    (window as unknown as { fusionShell: unknown }).fusionShell = shell;

    render(<DesktopLaunchGate><div>app</div></DesktopLaunchGate>);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Startup phase: create-store"));
    expect(screen.getByText("Show technical details")).toBeTruthy();
  });

  it("keeps structured diagnostics after a chooser local selection rejects", async () => {
    stubLocation("file:///C:/app/index.html");
    const failure = {
      phase: "server-listen" as const, attempts: 1, name: "Error", message: "port unavailable", stack: "Error: port unavailable",
      platform: "linux", nodeVersion: "22", occurredAt: "2026-09-08T00:00:00.000Z",
    };
    const chooser = { ...localReadyState, desktopMode: null, desktopModeState: { isFirstRun: true, desktopMode: null }, localRuntime: { source: "none", state: "stopped" } };
    const failed = { ...localReadyState, localRuntime: { source: "embedded-local", state: "error", error: "port unavailable", startupFailure: failure } };
    let attempted = false;
    const shell = {
      getState: vi.fn(async () => (attempted ? failed : chooser)),
      setDesktopMode: vi.fn(async () => { attempted = true; throw new Error("port unavailable"); }),
      onResetDesktopModeRequest: vi.fn(() => () => undefined),
      resetDesktopMode: vi.fn(async () => undefined),
    };
    (window as unknown as { fusionShell: unknown }).fusionShell = shell;

    render(<DesktopLaunchGate><div>app</div></DesktopLaunchGate>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Fusion Locally" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Run Fusion Locally" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Startup phase: server-listen"));
    expect(screen.getByText("Show technical details")).toBeTruthy();
  });

  it("offers selectable details when clipboard access is unavailable", async () => {
    stubLocation("file:///C:/app/index.html");
    const failure = {
      phase: "create-store" as const, attempts: 1, name: "Error", message: "boom", stack: "Error: boom",
      platform: "linux", nodeVersion: "22", occurredAt: "2026-09-08T00:00:00.000Z",
    };
    stubShell({ ...localReadyState, localRuntime: { source: "embedded-local", state: "error", error: "boom", startupFailure: failure } });

    render(<DesktopLaunchGate><div>app</div></DesktopLaunchGate>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect((screen.getByLabelText("Startup details") as HTMLTextAreaElement).value).toContain("Error: boom"));
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
