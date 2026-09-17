import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { browserState } = vi.hoisted(() => ({
  browserState: {
    value: {
      entries: [] as Array<{ name: string; path: string; type: "file" | "dir" }>,
      currentPath: "",
      setPath: vi.fn(),
      loading: false,
      error: null as string | null,
      refresh: vi.fn(),
    },
  },
}));

vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => browserState.value,
}));

import { FilesView } from "../FilesView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/*
 * FN-426: Files is a real destination now that the right dock is optional, so it must render as a page with its own
 * header — and it must keep delegating every file open to the shared `openFile` seam instead of becoming a second
 * editor owner.
 */
describe("FilesView", () => {
  it("renders the workspace browser as a titled page", () => {
    browserState.value = { ...browserState.value, entries: [{ name: "README.md", path: "README.md", type: "file" }] };
    render(<FilesView projectId="project-1" openFile={vi.fn()} />);

    expect(screen.getByTestId("files-view")).toBeInTheDocument();
    expect(screen.getByTestId("files-view-title")).toHaveTextContent("Files");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();
  });

  it("delegates a selected file to the shared open seam exactly once", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn();
    browserState.value = { ...browserState.value, entries: [{ name: "README.md", path: "README.md", type: "file" }], error: null };
    render(<FilesView projectId="project-1" openFile={openFile} />);

    await user.click(screen.getByText("README.md"));
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith("README.md", { workspace: "project" });
  });

  it("surfaces the browser's own error and retry rather than a page-level one", () => {
    const refresh = vi.fn();
    browserState.value = { ...browserState.value, entries: [], error: "Workspace unavailable", refresh };
    render(<FilesView projectId="project-1" />);

    expect(screen.getByText(/Workspace unavailable/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renders an empty workspace without an error", () => {
    browserState.value = { ...browserState.value, entries: [], error: null };
    render(<FilesView projectId="project-1" />);
    expect(screen.getByTestId("files-view")).toBeInTheDocument();
    expect(screen.queryByText(/Workspace unavailable/)).not.toBeInTheDocument();
  });
});
