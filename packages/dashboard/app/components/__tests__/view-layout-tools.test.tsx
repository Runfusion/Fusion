import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SecretsView } from "../SecretsView";
import { PullRequestView } from "../PullRequestView";
import { DockFilesView } from "../DockFilesView";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import type { FileNode } from "../../api";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 covers the tool destinations with their real components: Secrets keeps one canonical creation entry in the
shared header, Pull Requests returns from a selected item through the common chevron before its title, and the
dock's list-only Files host stays a plain list without nesting a second rail.
*/

const { browserState } = vi.hoisted(() => ({
  browserState: { entries: [] as FileNode[], loading: false, error: null as string | null, refresh: vi.fn() },
}));

vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => ({ ...browserState, currentPath: "", setPath: vi.fn() }),
}));
vi.mock("../../hooks/useWorkspaceFileEditor", () => ({
  useWorkspaceFileEditor: () => ({
    content: "", setContent: vi.fn(), originalContent: "", loading: false, saving: false,
    error: null, save: vi.fn(), hasChanges: false, mtime: "2026-09-13T08:37:00Z",
  }),
}));
vi.mock("../../hooks/useWorkspaces", () => ({
  useWorkspaces: () => ({ projectName: "Fusion", workspaces: [], loading: false, error: null }),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function pullRequest(id: string, repo: string) {
  return {
    id,
    repo,
    prNumber: 1,
    headBranch: `fusion/${id}`,
    baseBranch: "main",
    state: "open",
    title: `PR ${id}`,
    url: `https://example.invalid/${id}`,
    checks: [],
    threads: [],
    summary: { checksRollup: "success", mergeable: "MERGEABLE", reviewDecision: null },
  };
}

describe("FN-379 standardized tool destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    browserState.entries = [];
    browserState.error = null;
    browserState.loading = false;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a single canonical Secrets creation entry in the shared header, empty and populated", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("sync-passphrase")) return jsonResponse({ configured: false });
      return jsonResponse({ secrets: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <ViewLayoutProvider projectId="proj-tools"><SecretsView addToast={vi.fn()} projectId="proj-tools" /></ViewLayoutProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const banner = screen.getByRole("banner");
    const create = within(banner).getByRole("button", { name: "Add Secret" });
    expect(create).toHaveClass("view-action-button--create");
    expect(screen.getAllByRole("button", { name: "Add Secret" })).toHaveLength(1);

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("sync-passphrase")) return jsonResponse({ configured: false });
      return jsonResponse({ secrets: [{ key: "API_TOKEN", scope: "project", updatedAt: "2026-01-01T00:00:00.000Z" }] });
    });
    rerender(
      <ViewLayoutProvider projectId="proj-tools"><SecretsView addToast={vi.fn()} projectId="proj-tools" /></ViewLayoutProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Add Secret" })).toHaveLength(1));
  });

  it("reveals no secret value merely by mounting the destination", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("sync-passphrase")) return jsonResponse({ configured: false });
      if (url.includes("/reveal")) throw new Error("reveal must not be requested on mount");
      return jsonResponse({ secrets: [{ key: "API_TOKEN", scope: "project", updatedAt: "2026-01-01T00:00:00.000Z" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ViewLayoutProvider projectId="proj-tools"><SecretsView addToast={vi.fn()} projectId="proj-tools" /></ViewLayoutProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/reveal"))).toBe(false);
  });

  it("returns from a selected pull request through the shared header chevron", async () => {
    const loadPullRequests = vi.fn().mockResolvedValue([pullRequest("pr-1", "owner/repo")]);
    const loadPullRequest = vi.fn().mockResolvedValue(pullRequest("pr-1", "owner/repo"));
    render(
      <ViewLayoutProvider projectId="proj-tools">
        <PullRequestView projectId="proj-tools" loadPullRequests={loadPullRequests} loadPullRequest={loadPullRequest} onAction={vi.fn()} />
      </ViewLayoutProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("pr-list")).toBeInTheDocument());
    expect(screen.queryByTestId("pr-back-to-list")).toBeNull();

    fireEvent.click(screen.getAllByTestId("pr-list-item")[0]);
    await waitFor(() => expect(screen.getByTestId("pr-back-to-list")).toBeInTheDocument());

    const back = screen.getByTestId("pr-back-to-list");
    expect(back).toHaveClass("view-back-button");
    expect(within(screen.getByRole("banner")).getByTestId("pr-back-to-list")).toBe(back);
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByTestId("pr-list")).toBeInTheDocument());
  });

  it("keeps the Pull Requests header on its empty state without inventing a creation entry", async () => {
    render(
      <ViewLayoutProvider projectId="proj-tools">
        <PullRequestView projectId="proj-tools" loadPullRequests={vi.fn().mockResolvedValue([])} loadPullRequest={vi.fn()} onAction={vi.fn()} />
      </ViewLayoutProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("pr-list-empty")).toBeInTheDocument());
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(document.querySelectorAll(".view-action-button--create")).toHaveLength(0);
  });

  it("keeps the list-only dock Files host free of a nested rail and of implicit editing", () => {
    browserState.entries = [{ name: "readme.md", type: "file", size: 10, mtime: "2026-01-15T10:30:00Z" }];
    const openFile = vi.fn();
    render(
      <ViewLayoutProvider projectId="proj-tools"><DockFilesView projectId="proj-tools" openFile={openFile} /></ViewLayoutProvider>,
    );

    expect(document.querySelectorAll(".view-sidebar")).toHaveLength(0);
    fireEvent.click(screen.getByText("readme.md"));
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".file-editor")).toBeNull();
  });
});
