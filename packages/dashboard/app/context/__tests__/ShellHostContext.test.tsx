import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ShellHostProvider, useShellHostContext } from "../ShellHostContext";
import { __resetShellHostContextForTests } from "../../shell-host";

function Probe() {
  const value = useShellHostContext();
  return <pre data-testid="host">{JSON.stringify(value)}</pre>;
}

describe("ShellHostContext", () => {
  beforeEach(() => {
    __resetShellHostContextForTests();
    window.history.replaceState({}, "", "/");
    delete (window as Window & Record<string, unknown>).__FUSION_SHELL_HOST_CONTEXT__;
  });

  it("provides browser defaults", () => {
    render(
      <ShellHostProvider>
        <Probe />
      </ShellHostProvider>,
    );

    const value = JSON.parse(screen.getByTestId("host").textContent ?? "{}");
    expect(value.kind).toBe("browser");
    expect(value.isNativeShell).toBe(false);
  });

  it("provides normalized shell fields", () => {
    (window as Window & Record<string, unknown>).__FUSION_SHELL_HOST_CONTEXT__ = {
      kind: "desktop-shell",
      mode: "remote",
      connectionId: "conn-2",
      serverUrl: "https://remote.example.com",
      canOpenConnectionManager: true,
    };

    render(
      <ShellHostProvider>
        <Probe />
      </ShellHostProvider>,
    );

    const value = JSON.parse(screen.getByTestId("host").textContent ?? "{}");
    expect(value.isNativeShell).toBe(true);
    expect(value.kind).toBe("desktop-shell");
    expect(value.mode).toBe("remote");
    expect(value.connectionId).toBe("conn-2");
    expect(value.serverUrl).toBe("https://remote.example.com");
    expect(value.canOpenConnectionManager).toBe(true);
  });
});
