import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeShellConnectionStatus } from "../NativeShellConnectionStatus";

describe("NativeShellConnectionStatus", () => {
  it("shows local label for desktop local mode", () => {
    render(
      <NativeShellConnectionStatus
        state={{ host: "desktop-shell", desktopMode: "local", activeProfileId: null, profiles: [] }}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText("Local Fusion")).toBeInTheDocument();
  });

  it("opens manager when clicked", () => {
    const onManage = vi.fn();
    render(
      <NativeShellConnectionStatus
        state={{ host: "mobile-shell", activeProfileId: "p1", profiles: [{ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" }] }}
        onManage={onManage}
      />,
    );

    fireEvent.click(screen.getByTestId("native-shell-status-btn"));
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
