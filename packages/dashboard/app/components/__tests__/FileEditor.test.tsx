import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileEditor } from "../FileEditor";

describe("FileEditor", () => {
  const getEditorView = () => {
    const editor = document.querySelector(".cm-editor") as HTMLElement | null;
    if (!editor) {
      throw new Error("Expected .cm-editor to exist");
    }
    const view = EditorView.findFromDOM(editor);
    if (!view) {
      throw new Error("Expected CodeMirror EditorView instance");
    }
    return view;
  };

  const expandEditorOptions = () => {
    const toggle = screen.getByRole("button", { name: /toggle editor options/i });
    if (toggle.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(toggle);
    }
  };

  const highlightedTokenSelector = ".cm-line span[class]";

  it("renders CodeMirror editor with file-path aria-label", () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="" onChange={vi.fn()} filePath="a.ts" />);
    expect(screen.getByLabelText("Editor for a.ts")).toBeInTheDocument();
    expect(document.querySelector(".cm-editor")).toBeInTheDocument();
  });

  it("calls onChange when document changes", () => {
    document.documentElement.dataset.theme = "dark";
    const onChange = vi.fn();
    render(<FileEditor content="" onChange={onChange} filePath="a.ts" />);
    const view = getEditorView();
    view.dispatch({ changes: { from: 0, insert: "new content" } });
    expect(onChange).toHaveBeenCalledWith("new content");
  });

  it("respects readOnly prop", () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="readonly" onChange={vi.fn()} readOnly filePath="a.ts" />);
    expect(document.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
  });

  it("uses fallback aria-label when filePath missing", () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="x" onChange={vi.fn()} />);
    expect(screen.getByLabelText("File editor")).toBeInTheDocument();
  });

  it("markdown preview toggle still works", () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
    expandEditorOptions();
    fireEvent.click(screen.getByRole("button", { name: /preview mode/i }));
    expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));
    expect(document.querySelector(".cm-editor")).toBeInTheDocument();
  });
  it("line-number toggle still flips state and gutter visibility", () => {
    document.documentElement.dataset.theme = "dark";
    const onToggle = vi.fn();
    const { rerender } = render(
      <FileEditor content="a\nb" onChange={vi.fn()} filePath="a.ts" showLineNumbers={false} onToggleLineNumbers={onToggle} />,
    );

    expandEditorOptions();
    fireEvent.click(screen.getByRole("button", { name: /toggle line numbers/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".cm-gutters")).not.toBeInTheDocument();

    rerender(<FileEditor content="a\nb" onChange={vi.fn()} filePath="a.ts" showLineNumbers onToggleLineNumbers={onToggle} />);
    expect(document.querySelector(".cm-gutters")).toBeInTheDocument();
  });

  it("word-wrap toggle still works", () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="long long content" onChange={vi.fn()} filePath="a.ts" />);
    expandEditorOptions();
    const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
    expect(wrapButton.classList.contains("btn-primary")).toBe(true);
    fireEvent.click(wrapButton);
    expect(wrapButton.classList.contains("btn-primary")).toBe(false);
    fireEvent.click(wrapButton);
    expect(wrapButton.classList.contains("btn-primary")).toBe(true);
  });

  it("light mode produces highlighted tokens", async () => {
    document.documentElement.dataset.theme = "light";
    render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="foo.ts" />);

    await waitFor(() => {
      expect(document.querySelector(highlightedTokenSelector)).toBeInTheDocument();
    });
  });

  it("dark mode produces highlighted tokens", async () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="foo.ts" />);

    await waitFor(() => {
      expect(document.querySelector(highlightedTokenSelector)).toBeInTheDocument();
    });
  });

  it("theme switch reconfigures without remount", async () => {
    document.documentElement.dataset.theme = "dark";
    render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="foo.ts" />);

    const initialContentNode = document.querySelector(".cm-content");
    const editor = document.querySelector(".cm-editor");
    const initialEditorClassName = editor?.className;
    expect(initialContentNode).toBeInTheDocument();

    document.documentElement.dataset.theme = "light";

    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toBe(initialContentNode);
      expect(document.querySelector(highlightedTokenSelector)).toBeInTheDocument();
      expect(document.querySelector(".cm-editor")?.className).not.toBe(initialEditorClassName);
    });
  });

  it("language is still resolved for json", async () => {
    document.documentElement.dataset.theme = "light";
    render(<FileEditor content={"{\"a\":1}"} onChange={vi.fn()} filePath="foo.json" />);

    await waitFor(() => {
      expect(document.querySelector('.cm-content[data-language="json"]')).toBeInTheDocument();
      expect(document.querySelector(highlightedTokenSelector)).toBeInTheDocument();
    });
  });

  describe("markdown preview", () => {
    it("shows edit/preview toggle for markdown extensions when expanded", () => {
      const { rerender } = render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
      expandEditorOptions();
      expect(screen.getByRole("button", { name: /edit mode/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();

      rerender(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.markdown" />);
      expandEditorOptions();
      expect(screen.getByRole("button", { name: /edit mode/i })).toBeInTheDocument();

      rerender(<FileEditor content="# Hello" onChange={vi.fn()} filePath="page.mdx" />);
      expandEditorOptions();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("does not show edit/preview toggle for non-markdown files", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      expect(screen.queryByRole("button", { name: /edit mode/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
    });

    it("switches preview and edit when expanded", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      expandEditorOptions();
      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);
      expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();

      const editButton = screen.getByRole("button", { name: /edit mode/i });
      fireEvent.click(editButton);
      expect(document.querySelector(".cm-editor")).toBeInTheDocument();
    });

    it("readOnly markdown shows preview action when expanded", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" readOnly />);
      expandEditorOptions();
      expect(screen.queryByRole("button", { name: /edit mode/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });
  });

  describe("word wrap toggle", () => {
    it("shows word wrap toggle button for markdown files in edit mode", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);

      expandEditorOptions();
      expect(screen.getByRole("button", { name: /toggle word wrap/i })).toBeInTheDocument();
    });

    it("shows word wrap toggle button for non-markdown files", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);

      expandEditorOptions();
      expect(screen.getByRole("button", { name: /toggle word wrap/i })).toBeInTheDocument();
    });

    it("does not show word wrap toggle button in readOnly mode", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" readOnly />);

      expect(screen.queryByRole("button", { name: /toggle word wrap/i })).not.toBeInTheDocument();
    });

    it("word wrap is enabled by default", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);

      expect(document.querySelector(".cm-content.cm-lineWrapping")).toBeInTheDocument();
    });

    it("toggle button shows active state when word wrap is enabled", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);

      expandEditorOptions();
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      expect(wrapButton.classList.contains("btn-primary")).toBe(true);
    });

    it("clicking toggle button disables word wrap", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);

      expandEditorOptions();
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      fireEvent.click(wrapButton);

      expect(document.querySelector(".cm-content.cm-lineWrapping")).not.toBeInTheDocument();
    });

    it("clicking toggle button again re-enables word wrap", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);

      expandEditorOptions();
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      fireEvent.click(wrapButton);
      fireEvent.click(wrapButton);

      expect(document.querySelector(".cm-content.cm-lineWrapping")).toBeInTheDocument();
    });

    it("toggle button loses active state when word wrap is disabled", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);

      expandEditorOptions();
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      fireEvent.click(wrapButton);

      expect(wrapButton.classList.contains("btn-primary")).toBe(false);
    });
  });

  describe("line numbers", () => {
    it("shows the line number toggle button when toggle support is provided", () => {
      render(
        <FileEditor
          content={"first\nsecond\nthird"}
          onChange={vi.fn()}
          filePath="src/app.ts"
          showLineNumbers={false}
          onToggleLineNumbers={vi.fn()}
        />,
      );

      expandEditorOptions();
      expect(screen.getByRole("button", { name: /toggle line numbers/i })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: /toggle line numbers/i })).toHaveAttribute("title", "Toggle line numbers");
    });

    it("hides the line number toggle button when toggle support is not provided", () => {
      render(<FileEditor content="first\nsecond" onChange={vi.fn()} filePath="src/app.ts" showLineNumbers={false} />);

      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
    });

    it("calls onToggleLineNumbers when the toggle button is clicked", () => {
      const onToggleLineNumbers = vi.fn();
      render(
        <FileEditor
          content="first\nsecond"
          onChange={vi.fn()}
          filePath="src/app.ts"
          onToggleLineNumbers={onToggleLineNumbers}
        />,
      );

      expandEditorOptions();
      fireEvent.click(screen.getByRole("button", { name: /toggle line numbers/i }));
      expect(onToggleLineNumbers).toHaveBeenCalledTimes(1);
    });

    it("hides the line number toggle button for read-only files", () => {
      render(
        <FileEditor
          content={"one\ntwo"}
          onChange={vi.fn()}
          filePath="file.bin"
          readOnly
          showLineNumbers
          onToggleLineNumbers={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
    });

    it("shows line numbers for editable text mode when enabled", () => {
      render(
        <FileEditor
          content={"first\nsecond\nthird"}
          onChange={vi.fn()}
          filePath="src/app.ts"
          showLineNumbers
          onToggleLineNumbers={vi.fn()}
        />,
      );

      const gutter = document.querySelector(".cm-gutters");
      expect(gutter).toBeInTheDocument();
    });

    it("hides line numbers in markdown preview mode", () => {
      render(
        <FileEditor
          content="# Heading"
          onChange={vi.fn()}
          filePath="readme.md"
          showLineNumbers
          onToggleLineNumbers={vi.fn()}
        />,
      );

      expandEditorOptions();
      fireEvent.click(screen.getByRole("button", { name: /preview mode/i }));
      expect(document.querySelector(".file-editor-line-numbers")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
    });

    it("hides line numbers for read-only files", () => {
      render(
        <FileEditor
          content={"one\ntwo"}
          onChange={vi.fn()}
          filePath="file.bin"
          readOnly
          showLineNumbers
          onToggleLineNumbers={vi.fn()}
        />,
      );

      expect(document.querySelector(".file-editor-line-numbers")).not.toBeInTheDocument();
    });
  });

  describe("editor toolbar options collapse", () => {
    it("hides edit, preview, line numbers, and wrap while collapsed", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" onToggleLineNumbers={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /edit mode/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /preview mode/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle word wrap/i })).not.toBeInTheDocument();
    });

    it("expanding shows all actions in one toolbar actions row", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" onToggleLineNumbers={vi.fn()} />);
      expandEditorOptions();

      const editButton = screen.getByRole("button", { name: /edit mode/i });
      const actionsRow = editButton.closest(".file-editor-toolbar-actions");
      expect(actionsRow).toBeTruthy();
      expect(actionsRow).toContainElement(screen.getByRole("button", { name: /preview mode/i }));
      expect(actionsRow).toContainElement(screen.getByRole("button", { name: /toggle line numbers/i }));
      expect(actionsRow).toContainElement(screen.getByRole("button", { name: /toggle word wrap/i }));
    });

    it.each([/edit mode/i, /preview mode/i, /toggle line numbers/i, /toggle word wrap/i])(
      "expanded action button %s uses compact toolbar class signature",
      (name) => {
        render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" onToggleLineNumbers={vi.fn()} />);
        expandEditorOptions();
        const button = screen.getByRole("button", { name });
        expect(button.className).toContain("btn");
        expect(button.className).toContain("btn-sm");
        expect(button.className).toContain("file-editor-toolbar-button");
      },
    );

    it("aria-expanded reflects state", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" onToggleLineNumbers={vi.fn()} />);
      const optionsButton = screen.getByRole("button", { name: /toggle editor options/i });
      expect(optionsButton).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(optionsButton);
      expect(optionsButton).toHaveAttribute("aria-expanded", "true");
    });
  });

  describe("toolbar sizing CSS", () => {
    it("keeps equal height and font-size for all toolbar buttons on desktop and mobile", () => {
      const css = loadAllAppCss();
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);

      try {
        render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" onToggleLineNumbers={vi.fn()} />);
        expandEditorOptions();

        const buttons = [
          screen.getByRole("button", { name: /edit mode/i }),
          screen.getByRole("button", { name: /preview mode/i }),
          screen.getByRole("button", { name: /toggle line numbers/i }),
          screen.getByRole("button", { name: /toggle word wrap/i }),
        ];

        const desktopStyles = buttons.map((button) => getComputedStyle(button));
        expect(new Set(desktopStyles.map((styleDecl) => styleDecl.height)).size).toBe(1);
        expect(new Set(desktopStyles.map((styleDecl) => styleDecl.fontSize)).size).toBe(1);

        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: query.includes("max-width: 768px"),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }));

        const mobileStyles = buttons.map((button) => getComputedStyle(button));
        expect(new Set(mobileStyles.map((styleDecl) => styleDecl.height)).size).toBe(1);
        expect(new Set(mobileStyles.map((styleDecl) => styleDecl.fontSize)).size).toBe(1);
      } finally {
        style.remove();
      }
    });

    it("reduces toolbar vertical padding when expanded", () => {
      const css = loadAllAppCss();
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);

      try {
        render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" onToggleLineNumbers={vi.fn()} />);
        const toolbar = document.querySelector(".file-editor-toolbar") as HTMLElement;
        const collapsed = getComputedStyle(toolbar);

        expandEditorOptions();
        const expanded = getComputedStyle(toolbar);

        expect(expanded.paddingTop).not.toBe(collapsed.paddingTop);
        expect(expanded.paddingBottom).not.toBe(collapsed.paddingBottom);
      } finally {
        style.remove();
      }
    });
  });
});
