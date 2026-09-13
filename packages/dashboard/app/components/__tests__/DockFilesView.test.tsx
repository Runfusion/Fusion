import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../../api";
import { DockFilesView } from "../DockFilesView";
import { readAppFile } from "../../test/cssFixture";

const { browserState } = vi.hoisted(() => ({
  browserState: {
    entries: [] as FileNode[],
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => ({
    ...browserState,
    currentPath: "",
    setPath: vi.fn(),
  }),
}));

const files: FileNode[] = [
  { name: "readme.md", type: "file", size: 10, mtime: "2026-01-15T10:30:00Z" },
  { name: "logo.png", type: "file", size: 20, mtime: "2026-01-15T10:30:00Z" },
  { name: "manual.pdf", type: "file", size: 30, mtime: "2026-01-15T10:30:00Z" },
];

describe("DockFilesView", () => {
  beforeEach(() => {
    browserState.entries = files;
    browserState.loading = false;
    browserState.error = null;
    browserState.refresh.mockReset();
  });

  it.each(files)("délègue $name au modal partagé sans monter d’éditeur", (file) => {
    const openFile = vi.fn();
    render(<DockFilesView projectId="project-1" openFile={openFile} />);

    fireEvent.click(screen.getByText(file.name));

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith(file.name, { workspace: "project" });
    expect(screen.queryByTestId("right-dock-files-viewer")).toBeNull();
    expect(screen.queryByTestId("right-dock-files-back")).toBeNull();
    expect(screen.queryByTestId("right-dock-files-popout")).toBeNull();
    expect(screen.queryByTestId("right-dock-files-save")).toBeNull();
    expect(document.querySelector(".file-editor")).toBeNull();
  });

  it("conserve l’état d’erreur et la nouvelle tentative de la liste", () => {
    browserState.entries = [];
    browserState.error = "Lecture impossible";
    render(<DockFilesView projectId="project-1" openFile={vi.fn()} />);

    expect(document.querySelector(".file-browser-error")).toHaveTextContent(/Error/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(browserState.refresh).toHaveBeenCalledTimes(1);
  });

  it("utilise uniquement les tokens et remplit le body du dock", () => {
    const css = readAppFile("components/DockFilesView.css");
    expect(css).toContain("flex: 1 1 auto");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});
