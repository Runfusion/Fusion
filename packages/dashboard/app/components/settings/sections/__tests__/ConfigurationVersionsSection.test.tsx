import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConfirmDialogProvider } from "../../../../hooks/useConfirm";
import { ConfigurationVersionsSection } from "../ConfigurationVersionsSection";

const api = vi.fn();
vi.mock("../../../../api/legacy", () => ({
  api: (...args: unknown[]) => api(...args),
  withProjectId: (path: string, projectId?: string) => projectId ? `${path}?projectId=${projectId}` : path,
}));

function renderSection() {
  const onSettingsRefresh = vi.fn().mockResolvedValue(undefined);
  render(<ConfirmDialogProvider><ConfigurationVersionsSection projectId="project-1" onSettingsRefresh={onSettingsRefresh} /></ConfirmDialogProvider>);
  return { onSettingsRefresh };
}

describe("ConfigurationVersionsSection", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("renders the empty project configuration history", async () => {
    api.mockResolvedValueOnce({ revisions: [] });
    renderSection();

    expect(await screen.findByTestId("settings-config-versions-empty")).toHaveTextContent("No configuration versions yet.");
    expect(api).toHaveBeenCalledWith("/config/revisions?projectId=project-1");
  });

  it("renders revision rows returned by the project-scoped API", async () => {
    api.mockResolvedValueOnce({ revisions: [{ id: "revision-1", configKind: "project-settings", createdAt: "2026-07-18T12:00:00.000Z", source: "mutation" }] });
    renderSection();

    expect(await screen.findByTestId("settings-config-versions-list")).toHaveTextContent("project-settings");
    expect(screen.getByRole("button", { name: "Roll back" })).toBeTruthy();
  });

  it("surfaces revision load failures without an empty list shell", async () => {
    api.mockRejectedValueOnce(new Error("history unavailable"));
    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent("history unavailable");
    expect(screen.queryByTestId("settings-config-versions-empty")).toBeNull();
    expect(screen.queryByTestId("settings-config-versions-list")).toBeNull();
  });

  it("rolls back a confirmed revision and refreshes settings", async () => {
    api.mockResolvedValueOnce({ revisions: [{ id: "revision-1", configKind: "project-settings", createdAt: "2026-07-18T12:00:00.000Z", source: "mutation" }] }).mockResolvedValueOnce({ revision: { id: "forward" } }).mockResolvedValueOnce({ revisions: [] });
    const { onSettingsRefresh } = renderSection();
    await screen.findByTestId("settings-config-versions-list");

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Roll back configuration?" })).getByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith("/config/revisions/revision-1/rollback?projectId=project-1", { method: "POST" }));
    await waitFor(() => expect(onSettingsRefresh).toHaveBeenCalledTimes(1));
  });
});
