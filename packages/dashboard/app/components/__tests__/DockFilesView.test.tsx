import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { DockFilesView } from "../DockFilesView";
import { FILE_EDITOR_AUTO_SAVE_STORAGE_KEY } from "../../hooks/useAutoSavePreference";
import { getScopedItem, scopedKey } from "../../utils/projectStorage";
import type { FileNode } from "../../api";

/*
FNXC:RightDockFiles 2026-06-22-23:30:
Proves the current-file path is shared between the dock instance and the popped-out (expand) instance via scoped storage: selecting a file in the dock persists it, and a freshly mounted expand instance reads it on mount and opens the SAME file in its viewer pane.
*/

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, options?: Record<string, string>) => {
      const value = fallback ?? _key;
      return options?.file ? value.replace("{{file}}", options.file) : value;
    },
  }),
}));

let entries: FileNode[] = [];

const defaultEntries: FileNode[] = [
  { name: "readme.md", type: "file", size: 10, mtime: "2026-01-15T10:30:00Z" },
  { name: "changed.txt", type: "file", size: 12, mtime: "2026-01-15T10:30:00Z" },
  { name: "assets/Logo.PNG", type: "file", size: 1024, mtime: "2026-01-15T10:30:00Z" },
  { name: "media/demo.mp4", type: "file", size: 2048, mtime: "2026-01-15T10:30:00Z" },
  { name: "sounds/theme.MP3", type: "file", size: 2048, mtime: "2026-01-15T10:30:00Z" },
  { name: "docs/manual.PDF", type: "file", size: 4096, mtime: "2026-01-15T10:30:00Z" },
  { name: "build/output.bin", type: "file", size: 8192, mtime: "2026-01-15T10:30:00Z" },
];

const dockFilesCss = readFileSync(resolve(__dirname, "../DockFilesView.css"), "utf8");

vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => ({
    entries,
    currentPath: "",
    setPath: vi.fn(),
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const mockFetchContent = vi.fn(() => Promise.resolve({ content: "# hi" }));
const mockSaveContent = vi.fn(() => Promise.resolve({ mtime: "2026-01-15T10:31:00Z" }));
const mockDownloadFileUrl = vi.fn((workspace: string, filePath: string, projectId?: string, options?: { inline?: boolean }) => {
  const params = new URLSearchParams({ workspace });
  if (projectId) params.set("projectId", projectId);
  if (options?.inline) params.set("inline", "1");
  return `/api/files/${encodeURIComponent(filePath)}/download?${params.toString()}`;
});
vi.mock("../../api", () => ({
  fetchWorkspaceFileContent: (...args: unknown[]) => mockFetchContent(...(args as [])),
  saveWorkspaceFileContent: (...args: unknown[]) => mockSaveContent(...(args as [])),
  downloadFileUrl: (...args: unknown[]) => mockDownloadFileUrl(...(args as [string, string, string | undefined, { inline?: boolean } | undefined])),
}));

const capturedEditorHookCalls: Array<{
  workspace: string;
  filePath: string | null;
  enabled: boolean;
  projectId?: string;
  autoSave?: boolean;
}> = [];
const mockSetContent = vi.fn();
const mockSave = vi.fn(() => Promise.resolve());

vi.mock("../../hooks/useWorkspaceFileEditor", () => ({
  useWorkspaceFileEditor: (workspace: string, filePath: string | null, enabled: boolean, projectId?: string, autoSave?: boolean) => {
    capturedEditorHookCalls.push({ workspace, filePath, enabled, projectId, autoSave });
    const hasChanges = filePath === "changed.txt";
    return {
      content: filePath ? `content for ${filePath}` : "",
      setContent: mockSetContent,
      originalContent: hasChanges ? "original" : filePath ? `content for ${filePath}` : "",
      loading: false,
      saving: false,
      error: null,
      save: mockSave,
      hasChanges,
      mtime: null,
    };
  },
}));

const capturedFileEditorProps: Array<{
  filePath?: string;
  toolbarExpanded?: boolean;
  forceToolbarActionsVisible?: boolean;
  showLineNumbers?: boolean;
  onToggleLineNumbers?: () => void;
  readOnly?: boolean;
  autoSaveEnabled?: boolean;
  onToggleAutoSave?: () => void;
}> = [];

// Keep the viewer simple: surface the file path it was asked to render and capture toolbar props.
vi.mock("../FileEditor", () => ({
  FileEditor: (props: {
    filePath?: string;
    toolbarExpanded?: boolean;
    forceToolbarActionsVisible?: boolean;
    showLineNumbers?: boolean;
    onToggleLineNumbers?: () => void;
    readOnly?: boolean;
    autoSaveEnabled?: boolean;
    onToggleAutoSave?: () => void;
  }) => {
    capturedFileEditorProps.push(props);
    return (
      <div data-testid="mock-file-editor" data-file-path={props.filePath}>
        {props.onToggleAutoSave ? (
          <button type="button" data-testid="file-editor-auto-save-toggle" aria-pressed={props.autoSaveEnabled ? "true" : "false"} onClick={props.onToggleAutoSave}>
            Auto-save
          </button>
        ) : null}
      </div>
    );
  },
}));

const capturedFileBrowserProps: Array<{ showProjectFileControls?: boolean; projectId?: string }> = [];

// Render the tree's files as buttons so we can click one.
vi.mock("../FileBrowser", () => ({
  FileBrowser: ({ entries: e, onSelectFile, showProjectFileControls, projectId }: { entries: FileNode[]; onSelectFile: (p: string) => void; showProjectFileControls?: boolean; projectId?: string }) => {
    capturedFileBrowserProps.push({ showProjectFileControls, projectId });
    return (
      <div data-testid="mock-file-browser" data-project-controls={showProjectFileControls ? "true" : "false"}>
        {e.map((entry) => (
          <button key={entry.name} type="button" onClick={() => onSelectFile(entry.name)}>
            {entry.name}
          </button>
        ))}
      </div>
    );
  },
}));

const PROJECT_ID = "proj-1";
const KEY = scopedKey("kb-dashboard-dock-files-current", PROJECT_ID);

describe("DockFilesView shared current-file state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    entries = [...defaultEntries];
    mockFetchContent.mockClear();
    mockSaveContent.mockClear();
    mockDownloadFileUrl.mockClear();
    mockSetContent.mockClear();
    mockSave.mockClear();
    capturedFileEditorProps.length = 0;
    capturedEditorHookCalls.length = 0;
    capturedFileBrowserProps.length = 0;
  });
  afterEach(() => cleanup());

  it("keeps right-dock Files view dividers tokenized and invisible by default", () => {
    /*
    FNXC:RightDockChrome 2026-06-23-19:10:
    The default Files dock view must not draw extra header or pane dividers unless a theme opts into the right-dock divider token.
    */
    expect(dockFilesCss).toContain("border-bottom: var(--chrome-divider-width, 1px) solid var(--right-dock-view-divider-color, transparent);");
    expect(dockFilesCss).toContain("border-right: var(--chrome-divider-width, 1px) solid var(--right-dock-view-divider-color, transparent);");
    expect(dockFilesCss).not.toContain("border-bottom: 1px solid var(--border);");
    expect(dockFilesCss).not.toContain("border-right: 1px solid var(--border);");
  });

  it("enables Files — Project controls in both compact and two-pane dock layouts", () => {
    const dock = render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    expect(screen.getByTestId("mock-file-browser")).toHaveAttribute("data-project-controls", "true");
    dock.unmount();

    render(<DockFilesView projectId={PROJECT_ID} layout="two-pane" />);
    expect(screen.getByTestId("mock-file-browser")).toHaveAttribute("data-project-controls", "true");
    expect(capturedFileBrowserProps.every((props) => props.showProjectFileControls === true && props.projectId === PROJECT_ID)).toBe(true);
  });

  it("persists the selected file to scoped storage and a fresh expand instance reads it on mount", async () => {
    // 1. Dock instance: select a file.
    const dock = render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("readme.md"));

    // The path was persisted to the shared scoped key.
    expect(getScopedItem("kb-dashboard-dock-files-current", PROJECT_ID)).toBe("readme.md");
    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });

    // 2. Unmount the dock; mount a SEPARATE expand instance (two-pane pop-out).
    dock.unmount();
    render(<DockFilesView projectId={PROJECT_ID} layout="two-pane" />);

    // The expand instance opened the SAME file from storage on mount.
    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });
    expect(screen.queryByTestId("right-dock-files-empty")).toBeNull();
    expect(screen.getByTestId("right-dock-files-view")).toHaveAttribute("data-layout", "two-pane");
  });

  it("clearing the file (back) clears the shared key", () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("readme.md"));
    expect(getScopedItem("kb-dashboard-dock-files-current", PROJECT_ID)).toBe("readme.md");

    fireEvent.click(screen.getByTestId("right-dock-files-back"));
    expect(getScopedItem("kb-dashboard-dock-files-current", PROJECT_ID)).toBeNull();
    expect(screen.getByTestId("right-dock-files-empty")).toBeInTheDocument();
  });

  it("live-syncs from a cross-instance storage event", async () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="two-pane" />);
    expect(screen.getByTestId("right-dock-files-empty")).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem(KEY, "readme.md");
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "readme.md" }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });
  });

  it("uses the full modal/mobile file editor toolbar in the right dock viewer", async () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("readme.md"));

    await waitFor(() => {
      expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md");
    });

    const latest = capturedFileEditorProps.at(-1);
    expect(latest).toMatchObject({
      filePath: "readme.md",
      toolbarExpanded: true,
      forceToolbarActionsVisible: true,
      showLineNumbers: true,
    });
    expect(latest?.readOnly).toBeFalsy();
    expect(latest?.onToggleLineNumbers).toEqual(expect.any(Function));
    expect(screen.getByTestId("right-dock-files-save")).toBeDisabled();
  });

  it.each(["auto", "two-pane"] as const)("wires the auto-save toggle in %s layout and persists the preference", async (layout) => {
    render(<DockFilesView projectId={PROJECT_ID} layout={layout} />);
    fireEvent.click(screen.getByText("readme.md"));

    await waitFor(() => expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md"));
    const toggle = screen.getByTestId("file-editor-auto-save-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(capturedFileEditorProps.at(-1)).toMatchObject({ autoSaveEnabled: true, onToggleAutoSave: expect.any(Function) });
    expect(capturedEditorHookCalls.at(-1)).toMatchObject({ workspace: "project", filePath: "readme.md", enabled: true, projectId: PROJECT_ID, autoSave: true });

    fireEvent.click(toggle);

    await waitFor(() => expect(window.localStorage.getItem(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY)).toBe("false"));
    await waitFor(() => expect(screen.getByTestId("file-editor-auto-save-toggle")).toHaveAttribute("aria-pressed", "false"));
    expect(capturedEditorHookCalls.at(-1)).toMatchObject({ workspace: "project", filePath: "readme.md", enabled: true, projectId: PROJECT_ID, autoSave: false });
  });

  it.each([
    {
      layout: "auto" as const,
      file: "assets/Logo.PNG",
      selector: "img.file-browser-preview-media--image",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "auto" as const,
      file: "media/demo.mp4",
      selector: "video.file-browser-preview-media--video",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "auto" as const,
      file: "sounds/theme.MP3",
      selector: "audio.file-browser-preview-media--audio",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "auto" as const,
      file: "docs/manual.PDF",
      selector: "iframe.file-browser-preview-media--pdf",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "two-pane" as const,
      file: "assets/Logo.PNG",
      selector: "img.file-browser-preview-media--image",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "two-pane" as const,
      file: "media/demo.mp4",
      selector: "video.file-browser-preview-media--video",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "two-pane" as const,
      file: "sounds/theme.MP3",
      selector: "audio.file-browser-preview-media--audio",
      attr: "src",
      expectedEnabled: false,
    },
    {
      layout: "two-pane" as const,
      file: "docs/manual.PDF",
      selector: "iframe.file-browser-preview-media--pdf",
      attr: "src",
      expectedEnabled: false,
    },
  ])("renders $file as a native preview in $layout layout without loading the editor", async ({ layout, file, selector, attr }) => {
    /*
    FNXC:RightDockFiles 2026-06-25-00:00:
    Symptom verification: browser-previewable files in both compact and pop-out dock layouts must use native preview elements backed by downloadFileUrl, not the FileEditor/CodeMirror binary-text path.
    */
    render(<DockFilesView projectId={PROJECT_ID} layout={layout} />);
    fireEvent.click(screen.getByText(file));

    await waitFor(() => expect(document.querySelector(selector)).toBeInTheDocument());
    const preview = document.querySelector(selector);
    expect(preview).toHaveAttribute(attr, `/api/files/${encodeURIComponent(file)}/download?workspace=project&projectId=${PROJECT_ID}&inline=1`);
    if (selector.startsWith("video") || selector.startsWith("audio")) {
      expect(preview).toHaveAttribute("controls");
      expect(preview).toHaveAttribute("aria-label", `Preview for ${file}`);
    }
    if (selector.startsWith("iframe")) {
      expect(preview).toHaveAttribute("title", `Preview for ${file}`);
    }
    expect(screen.queryByTestId("mock-file-editor")).toBeNull();
    expect(screen.queryByTestId("right-dock-files-save")).toBeNull();
    expect(capturedEditorHookCalls.at(-1)).toMatchObject({ workspace: "project", filePath: file, enabled: false, projectId: PROJECT_ID });
    expect(mockDownloadFileUrl).toHaveBeenLastCalledWith("project", file, PROJECT_ID, { inline: true });
  });

  it("keeps text files editable with Save when changes exist", async () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("changed.txt"));

    await waitFor(() => expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "changed.txt"));
    expect(screen.getByTestId("right-dock-files-save")).toBeEnabled();
    expect(document.querySelector(".file-browser-preview")).not.toBeInTheDocument();
    expect(capturedEditorHookCalls.at(-1)).toMatchObject({ workspace: "project", filePath: "changed.txt", enabled: true, projectId: PROJECT_ID });
    expect(mockDownloadFileUrl).not.toHaveBeenCalledWith("project", "changed.txt", PROJECT_ID, { inline: true });
  });

  it("keeps known non-preview binary files read-only without rendering garbage editor content", () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="two-pane" />);
    fireEvent.click(screen.getByText("build/output.bin"));

    expect(screen.getByTestId("right-dock-files-binary-read-only")).toHaveTextContent("Binary file — read only");
    expect(screen.queryByTestId("mock-file-editor")).toBeNull();
    expect(screen.queryByTestId("right-dock-files-save")).toBeNull();
    expect(document.querySelector(".file-browser-preview")).not.toBeInTheDocument();
    expect(capturedEditorHookCalls.at(-1)).toMatchObject({ workspace: "project", filePath: "build/output.bin", enabled: false, projectId: PROJECT_ID });
    expect(mockDownloadFileUrl).not.toHaveBeenCalledWith("project", "build/output.bin", PROJECT_ID, { inline: true });
  });

  it("clears stale preview state when switching from a preview file back to text", async () => {
    render(<DockFilesView projectId={PROJECT_ID} layout="auto" />);
    fireEvent.click(screen.getByText("assets/Logo.PNG"));
    await waitFor(() => expect(document.querySelector("img.file-browser-preview-media--image")).toBeInTheDocument());
    expect(document.querySelector("img.file-browser-preview-media--image")).toHaveAttribute("src", expect.stringContaining("inline=1"));

    fireEvent.click(screen.getByText("readme.md"));
    await waitFor(() => expect(screen.getByTestId("mock-file-editor")).toHaveAttribute("data-file-path", "readme.md"));

    expect(document.querySelector("img.file-browser-preview-media--image")).not.toBeInTheDocument();
    expect(screen.getByTestId("right-dock-files-save")).toBeDisabled();
    expect(capturedEditorHookCalls.at(-1)).toMatchObject({ workspace: "project", filePath: "readme.md", enabled: true, projectId: PROJECT_ID });
  });
});
