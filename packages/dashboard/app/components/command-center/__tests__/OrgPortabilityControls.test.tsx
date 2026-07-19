import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("renders the export/import controls without a configuration versions card", async () => {
    renderControls();

    expect(await screen.findByTestId("cc-controls-org-portability")).toBeTruthy();
    expect(screen.queryByTestId("cc-controls-config-versions")).toBeNull();
    expect(screen.getByRole("button", { name: "Export org bundle" })).toBeTruthy();
  });

  it("exports through the project-scoped route and reports success", async () => {
    api.mockResolvedValueOnce({ bundle: { version: 1 } });
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Export org bundle" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/org/export?projectId=project-1", { method: "POST" }));
    expect(await screen.findByText("Export ready")).toBeTruthy();
  });


  it("previews then confirms and applies an import", async () => {
    api.mockResolvedValueOnce({ result: { created: { agents: ["agent"] } } }).mockResolvedValueOnce({ result: {} });
    renderControls();
    fireEvent.change(screen.getByLabelText("Org bundle JSON"), { target: { value: '{"version":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    expect(await screen.findByTestId("cc-org-import-preview")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import bundle" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/org/import?projectId=project-1", expect.objectContaining({ method: "POST", body: JSON.stringify({ bundle: { version: 1 }, dryRun: false }) })));
  });

  it("invalidates a preview when the bundle changes before its dry-run response", async () => {
    let resolvePreview: ((value: { result: unknown }) => void) | undefined;
    api.mockImplementationOnce(() => new Promise<{ result: unknown }>((resolve) => { resolvePreview = resolve; }));
    renderControls();

    fireEvent.change(screen.getByLabelText("Org bundle JSON"), { target: { value: '{"version":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    fireEvent.change(screen.getByLabelText("Org bundle JSON"), { target: { value: '{"version":2}' } });
    expect(screen.getByRole("button", { name: "Apply import" })).toBeDisabled();

    resolvePreview?.({ result: { created: { agents: ["agent"] } } });
    await waitFor(() => expect(screen.queryByTestId("cc-org-import-preview")).toBeNull());
    expect(screen.getByRole("button", { name: "Apply import" })).toBeDisabled();
    expect(api).toHaveBeenCalledTimes(1);
  });

});
