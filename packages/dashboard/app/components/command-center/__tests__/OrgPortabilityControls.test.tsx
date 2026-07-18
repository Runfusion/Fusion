import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfirmDialogProvider } from "../../../hooks/useConfirm";
import { OrgPortabilityControls } from "../OrgPortabilityControls";

const api = vi.fn();
vi.mock("../../../api/legacy", () => ({
  api: (...args: unknown[]) => api(...args),
  withProjectId: (path: string, projectId?: string) => projectId ? `${path}?projectId=${projectId}` : path,
}));

function renderControls() {
  const onSettingsRefresh = vi.fn().mockResolvedValue(undefined);
  render(<ConfirmDialogProvider><OrgPortabilityControls projectId="project-1" onSettingsRefresh={onSettingsRefresh} /></ConfirmDialogProvider>);
  return { onSettingsRefresh };
}

describe("OrgPortabilityControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders the export/import and empty version surfaces", async () => {
    api.mockResolvedValueOnce({ revisions: [] });
    renderControls();

    expect(await screen.findByTestId("cc-controls-org-portability")).toBeTruthy();
    expect(screen.getByTestId("cc-controls-config-versions")).toBeTruthy();
    expect(screen.getByTestId("cc-config-versions-empty")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export org bundle" })).toBeTruthy();
  });

  it("exports through the project-scoped route and reports success", async () => {
    api.mockResolvedValueOnce({ revisions: [] }).mockResolvedValueOnce({ bundle: { version: 1 } });
    renderControls();
    await screen.findByTestId("cc-config-versions-empty");
    fireEvent.click(screen.getByRole("button", { name: "Export org bundle" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/org/export?projectId=project-1", { method: "POST" }));
    expect(await screen.findByText("Export ready")).toBeTruthy();
  });

  it("shows version load errors instead of an empty leftover list shell", async () => {
    api.mockRejectedValueOnce(new Error("history unavailable"));
    renderControls();

    expect(await screen.findByRole("alert")).toHaveTextContent("history unavailable");
    expect(screen.queryByTestId("cc-config-versions-empty")).toBeNull();
    expect(screen.queryByTestId("cc-config-versions-list")).toBeNull();
  });

  it("previews then confirms and applies an import", async () => {
    api.mockResolvedValueOnce({ revisions: [] }).mockResolvedValueOnce({ result: { created: { agents: ["agent"] } } }).mockResolvedValueOnce({ result: {} }).mockResolvedValueOnce({ revisions: [] });
    renderControls();
    await screen.findByTestId("cc-config-versions-empty");
    fireEvent.change(screen.getByLabelText("Org bundle JSON"), { target: { value: '{"version":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    expect(await screen.findByTestId("cc-org-import-preview")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import bundle" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/org/import?projectId=project-1", expect.objectContaining({ method: "POST", body: JSON.stringify({ bundle: { version: 1 }, dryRun: false }) })));
  });

  it("invalidates a preview when the bundle changes before its dry-run response", async () => {
    let resolvePreview: ((value: { result: unknown }) => void) | undefined;
    api.mockResolvedValueOnce({ revisions: [] }).mockImplementationOnce(() => new Promise<{ result: unknown }>((resolve) => { resolvePreview = resolve; }));
    renderControls();
    await screen.findByTestId("cc-config-versions-empty");

    fireEvent.change(screen.getByLabelText("Org bundle JSON"), { target: { value: '{"version":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    fireEvent.change(screen.getByLabelText("Org bundle JSON"), { target: { value: '{"version":2}' } });
    expect(screen.getByRole("button", { name: "Apply import" })).toBeDisabled();

    resolvePreview?.({ result: { created: { agents: ["agent"] } } });
    await waitFor(() => expect(screen.queryByTestId("cc-org-import-preview")).toBeNull());
    expect(screen.getByRole("button", { name: "Apply import" })).toBeDisabled();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("renders populated versions and rolls one back after confirmation", async () => {
    api.mockResolvedValueOnce({ revisions: [{ id: "revision-1", configKind: "project-settings", createdAt: "2026-07-18T12:00:00.000Z", source: "mutation" }] }).mockResolvedValueOnce({ revision: { id: "forward" } }).mockResolvedValueOnce({ revisions: [] });
    const { onSettingsRefresh } = renderControls();
    expect(await screen.findByTestId("cc-config-versions-list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Roll back configuration?" })).getByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/config/revisions/revision-1/rollback?projectId=project-1", { method: "POST" }));
    expect(onSettingsRefresh).toHaveBeenCalled();
  });
});
