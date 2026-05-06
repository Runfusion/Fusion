import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellProvider, useShellContext } from "../context/ShellContext";

function Probe() {
  const { openConnectionManagerSignal } = useShellContext();
  return <div data-testid="signal">{openConnectionManagerSignal}</div>;
}

describe("ShellProvider", () => {
  beforeEach(() => {
    window.fusionShell = {
      getState: vi.fn(async () => ({ host: "mobile-shell", activeProfileId: null, profiles: [] })),
      listProfiles: vi.fn(async () => []),
      saveProfile: vi.fn(),
      deleteProfile: vi.fn(),
      setActiveProfile: vi.fn(),
      setDesktopMode: vi.fn(),
      startQrScan: vi.fn(),
      openConnectionManager: vi.fn(async () => {
        window.dispatchEvent(new CustomEvent("shell:open-connection-manager"));
      }),
      subscribe: vi.fn(() => () => undefined),
    } as never;
  });

  it("increments open-connection-manager signal when event fires", async () => {
    const { getByTestId } = render(
      <ShellProvider>
        <Probe />
      </ShellProvider>,
    );

    expect(getByTestId("signal").textContent).toBe("0");
    window.dispatchEvent(new CustomEvent("shell:open-connection-manager"));

    await waitFor(() => {
      expect(getByTestId("signal").textContent).toBe("1");
    });
  });
});
