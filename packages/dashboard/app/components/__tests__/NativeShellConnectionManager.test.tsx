import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeShellConnectionManager } from "../NativeShellConnectionManager";

function createShellApi() {
  return {
    getState: vi.fn(),
    listProfiles: vi.fn(),
    saveProfile: vi.fn(async () => ({ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", createdAt: "", updatedAt: "" })),
    deleteProfile: vi.fn(async () => undefined),
    setActiveProfile: vi.fn(async () => ({ host: "mobile-shell", activeProfileId: "p1", profiles: [] })),
    setDesktopMode: vi.fn(async () => ({ host: "desktop-shell", desktopMode: "remote", activeProfileId: null, profiles: [] })),
    startQrScan: vi.fn(),
    openConnectionManager: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  };
}

describe("NativeShellConnectionManager", () => {
  it("switches desktop mode", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "desktop-shell", desktopMode: "remote", activeProfileId: null, profiles: [] }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Local"));
    await waitFor(() => expect(shellApi.setDesktopMode).toHaveBeenCalledWith("local"));
  });

  it("activates and deletes profiles", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "mobile-shell", activeProfileId: null, profiles: [{ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", authToken: null, createdAt: "", updatedAt: "" }] }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Use Prod"));
    fireEvent.click(screen.getByLabelText("Delete Prod"));

    await waitFor(() => {
      expect(shellApi.setActiveProfile).toHaveBeenCalledWith("p1");
      expect(shellApi.deleteProfile).toHaveBeenCalledWith("p1");
    });
  });

  it("edits and saves active profile", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "mobile-shell", activeProfileId: "p1", profiles: [{ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", authToken: null, createdAt: "", updatedAt: "" }] }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("https://fusion.example.com"), { target: { value: "https://next.example.com" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(shellApi.saveProfile).toHaveBeenCalled();
      expect(shellApi.setActiveProfile).toHaveBeenCalledWith("p1");
    });
  });
});
