import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeShellOnboardingModal } from "../NativeShellOnboardingModal";

describe("NativeShellOnboardingModal", () => {
  it("shows desktop mode options", () => {
    render(
      <NativeShellOnboardingModal
        open={true}
        shellApi={{
          getState: vi.fn(),
          listProfiles: vi.fn(),
          saveProfile: vi.fn(),
          deleteProfile: vi.fn(),
          setActiveProfile: vi.fn(),
          setDesktopMode: vi.fn(),
          startQrScan: vi.fn(),
          openConnectionManager: vi.fn(),
          subscribe: vi.fn(() => () => undefined),
        }}
        shellState={{ host: "desktop-shell", desktopMode: "remote", activeProfileId: null, profiles: [] }}
        onComplete={vi.fn()}
      />,
    );

    expect(screen.getByText("Local Fusion")).toBeInTheDocument();
    expect(screen.getByText("Remote Server")).toBeInTheDocument();
  });

  it("applies QR scan results", async () => {
    const startQrScan = vi.fn(async () => ({ serverUrl: "https://qr.example.com", authToken: "token-1" }));
    render(
      <NativeShellOnboardingModal
        open={true}
        shellApi={{
          getState: vi.fn(),
          listProfiles: vi.fn(),
          saveProfile: vi.fn(),
          deleteProfile: vi.fn(),
          setActiveProfile: vi.fn(),
          setDesktopMode: vi.fn(),
          startQrScan,
          openConnectionManager: vi.fn(),
          subscribe: vi.fn(() => () => undefined),
        }}
        shellState={{ host: "mobile-shell", activeProfileId: null, profiles: [] }}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Scan QR"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("https://qr.example.com")).toBeInTheDocument();
      expect(screen.getByDisplayValue("token-1")).toBeInTheDocument();
    });
  });

  it("saves remote profile and redirects to remote dashboard", async () => {
    const saveProfile = vi.fn(async () => ({ id: "p1", serverUrl: "https://fusion.example.com", authToken: "abc" }));
    const setActiveProfile = vi.fn(async () => ({
      host: "mobile-shell",
      activeProfileId: "p1",
      profiles: [
        { id: "existing", name: "Existing", serverUrl: "https://existing.example.com", createdAt: "", updatedAt: "" },
        { id: "p1", name: "Remote Server", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" },
      ],
    }));
    const onComplete = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "http://localhost" },
    });

    render(
      <NativeShellOnboardingModal
        open={true}
        shellApi={{
          getState: vi.fn(),
          listProfiles: vi.fn(),
          saveProfile,
          deleteProfile: vi.fn(),
          setActiveProfile,
          setDesktopMode: vi.fn(),
          startQrScan: vi.fn(),
          openConnectionManager: vi.fn(),
          subscribe: vi.fn(() => () => undefined),
        }}
        shellState={{
          host: "mobile-shell",
          activeProfileId: "existing",
          profiles: [{ id: "existing", name: "Existing", serverUrl: "https://existing.example.com", createdAt: "", updatedAt: "" }],
        }}
        onComplete={onComplete}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("https://your-fusion-host"), { target: { value: "https://fusion.example.com" } });
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Remote Server", serverUrl: "https://fusion.example.com" }));
      expect(setActiveProfile).toHaveBeenCalledWith("p1");
      expect(window.location.href).toContain("https://fusion.example.com");
      expect(window.location.href).toContain("rt=abc");
    });

    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
