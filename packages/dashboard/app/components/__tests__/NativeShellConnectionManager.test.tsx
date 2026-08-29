import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeShellConnectionManager } from "../NativeShellConnectionManager";

function createShellApi() {
  return {
    getState: vi.fn(),
    listProfiles: vi.fn(),
    saveProfile: vi.fn(async (input?: { id?: string; name?: string; serverUrl?: string; authToken?: string | null }) => ({
      id: input?.id ?? "p2",
      name: input?.name || "Prod",
      serverUrl: input?.serverUrl || "https://fusion.example.com",
      authToken: input?.authToken ?? null,
      createdAt: "",
      updatedAt: "",
    })),
    deleteProfile: vi.fn(async () => undefined),
    setActiveProfile: vi.fn(async () => ({ host: "mobile-shell", activeProfileId: "p1", profiles: [] })),
    setDesktopMode: vi.fn(async () => ({ host: "desktop-shell", desktopMode: "remote", activeProfileId: null, profiles: [] })),
    startQrScan: vi.fn(async () => ({ serverUrl: "https://qr.example.com", authToken: "token" })),
    openConnectionManager: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  };
}

const remoteProfile = {
  id: "remote-1",
  name: "Remote",
  serverUrl: "https://fusion.example.com",
  authToken: "token-value",
  createdAt: "",
  updatedAt: "",
};

describe("NativeShellConnectionManager", () => {
  it("explains desktop local mode with no remote profiles and hides the editor until add", () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "desktop-shell", desktopMode: "local", activeProfileId: null, profiles: [] }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Local Server" })).toBeInTheDocument();
    expect(screen.getByText("Use the embedded Fusion server on this device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current Local Server" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Remote servers" })).toBeInTheDocument();
    expect(screen.getByText(/No remote servers saved yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add remote server" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Local$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remote$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));

    expect(screen.getByRole("heading", { name: "Add remote server" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Server URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Auth token (optional)")).toHaveAttribute("type", "password");
  });

  it("keeps the Local Server destination available from desktop remote mode", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "desktop-shell", desktopMode: "remote", activeProfileId: "remote-1", profiles: [remoteProfile] }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Local Server" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Local Server" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Remote")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use Local Server" }));

    await waitFor(() => expect(shellApi.setDesktopMode).toHaveBeenCalledWith("local"));
    expect(shellApi.setActiveProfile).not.toHaveBeenCalled();
  });

  it("separates populated desktop remote profiles from local state and exposes deterministic actions", async () => {
    const shellApi = createShellApi();
    const duplicateNameProfiles = [
      remoteProfile,
      { ...remoteProfile, id: "remote-2", serverUrl: "https://other.example.com" },
    ];
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "desktop-shell", desktopMode: "local", activeProfileId: "remote-1", profiles: duplicateNameProfiles }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Current Local Server" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Add remote server" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();

    const firstCard = screen.getByText("https://fusion.example.com").closest(".native-shell-connection-manager__profile");
    expect(firstCard).not.toBeNull();
    expect(within(firstCard as HTMLElement).getByRole("button", { name: "Edit Remote at https://fusion.example.com" })).toBeInTheDocument();
    expect(within(firstCard as HTMLElement).getByRole("button", { name: "Use Remote at https://fusion.example.com" })).toBeInTheDocument();
    expect(within(firstCard as HTMLElement).getByRole("button", { name: "Delete Remote at https://fusion.example.com" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use Remote at https://other.example.com" }));

    await waitFor(() => {
      expect(shellApi.setDesktopMode).toHaveBeenCalledWith("remote");
      expect(shellApi.setActiveProfile).toHaveBeenCalledWith("remote-2");
    });
    expect(shellApi.setDesktopMode.mock.invocationCallOrder[0]).toBeLessThan(shellApi.setActiveProfile.mock.invocationCallOrder[0]);
  });

  it("validates and saves a new desktop remote profile only after add is chosen", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "desktop-shell", activeProfileId: null, profiles: [] }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Prod" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "ftp://fusion.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Server URL must use http or https");
    expect(shellApi.saveProfile).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://prod.example.com" } });
    fireEvent.change(screen.getByLabelText("Auth token (optional)"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(shellApi.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
        id: undefined,
        name: "Prod",
        serverUrl: "https://prod.example.com",
        authToken: "secret-token",
      }));
      expect(shellApi.setActiveProfile).toHaveBeenCalledWith("p2");
    });
    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();
  });

  it("edits an existing profile from a collapsed desktop editor", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "desktop-shell", desktopMode: "remote", activeProfileId: "remote-1", profiles: [remoteProfile] }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Remote at https://fusion.example.com" }));
    expect(screen.getByRole("heading", { name: "Edit remote server" })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("https://fusion.example.com"), { target: { value: "https://next.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(shellApi.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "remote-1", serverUrl: "https://next.example.com" }));
      expect(shellApi.setActiveProfile).toHaveBeenCalledWith("remote-1");
    });
  });

  it("keeps mobile QR, manual add, active state, and delete confirmation available", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "mobile-shell", activeProfileId: "p1", profiles: [{ id: "p1", name: "Prod", serverUrl: "https://fusion.example.com", authToken: null, createdAt: "", updatedAt: "" }] }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Local Server" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add remote server" })).not.toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan QR" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));

    await waitFor(() => {
      expect(shellApi.startQrScan).toHaveBeenCalled();
      expect(screen.getByDisplayValue("https://qr.example.com")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete Prod at https://fusion.example.com" }));
    expect(screen.getByRole("alertdialog", { name: "Delete server confirmation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(shellApi.deleteProfile).toHaveBeenCalledWith("p1");
    });
  });

  it("keeps mobile empty state focused on QR and manual entry without desktop guidance", async () => {
    const shellApi = createShellApi();
    render(
      <NativeShellConnectionManager
        open={true}
        shellApi={shellApi}
        shellState={{ host: "mobile-shell", activeProfileId: null, profiles: [] }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Local Server" })).not.toBeInTheDocument();
    expect(screen.getByText("No remote servers saved yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add server" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan QR" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(screen.getByLabelText("Server URL")).toBeInTheDocument();
  });
});
