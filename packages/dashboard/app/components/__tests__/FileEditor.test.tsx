import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: /toggle editor options/i }));
  };

  it("renders CodeMirror editor with file-path aria-label", () => {
    render(<FileEditor content="" onChange={vi.fn()} filePath="a.ts" />);
    expect(screen.getByLabelText("Editor for a.ts")).toBeInTheDocument();
    expect(document.querySelector(".cm-editor")).toBeInTheDocument();
  });

  it("calls onChange when document changes", () => {
    const onChange = vi.fn();
    render(<FileEditor content="" onChange={onChange} filePath="a.ts" />);
    const view = getEditorView();
    view.dispatch({ changes: { from: 0, insert: "new content" } });
    expect(onChange).toHaveBeenCalledWith("new content");
  });

  it("respects readOnly prop", () => {
    render(<FileEditor content="readonly" onChange={vi.fn()} readOnly filePath="a.ts" />);
    expect(document.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
  });

  it("uses fallback aria-label when filePath missing", () => {
    render(<FileEditor content="x" onChange={vi.fn()} />);
    expect(screen.getByLabelText("File editor")).toBeInTheDocument();
  });

  it("markdown preview toggle still works", () => {
    render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
    fireEvent.click(screen.getByRole("button", { name: /preview mode/i }));
    expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /edit mode/i }));
    expect(document.querySelector(".cm-editor")).toBeInTheDocument();
  });

  it("line-number toggle still flips state and gutter visibility", () => {
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
    render(<FileEditor content="long long content" onChange={vi.fn()} filePath="a.ts" />);
    expandEditorOptions();
    const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
    expect(wrapButton.classList.contains("btn-primary")).toBe(true);
    fireEvent.click(wrapButton);
    expect(wrapButton.classList.contains("btn-primary")).toBe(false);
    fireEvent.click(wrapButton);
    expect(wrapButton.classList.contains("btn-primary")).toBe(true);
  });

  describe("markdown preview", () => {
    it("shows edit/preview toggle for .md files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
      
      expect(screen.getByRole("button", { name: /edit mode/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("shows edit/preview toggle for .markdown files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.markdown" />);
      
      expect(screen.getByRole("button", { name: /edit mode/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("shows edit/preview toggle for .mdx files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="page.mdx" />);
      
      expect(screen.getByRole("button", { name: /edit mode/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("does not show edit/preview toggle for non-markdown files", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      expect(screen.queryByRole("button", { name: /edit mode/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
    });

    it("does not show edit/preview toggle when filePath is not provided", () => {
      render(<FileEditor content="some content" onChange={vi.fn()} />);
      
      expect(screen.queryByRole("button", { name: /edit mode/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
    });

    it("defaults to edit mode for markdown files", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      expect(document.querySelector(".cm-editor")).toBeInTheDocument();
    });

    it("switches to preview mode when preview button is clicked", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);

      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);

      expect(document.querySelector(".cm-editor")).not.toBeInTheDocument();
      expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();
    });

    it("switches back to edit mode when edit button is clicked", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);

      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);

      const editButton = screen.getByRole("button", { name: /edit mode/i });
      fireEvent.click(editButton);

      expect(document.querySelector(".cm-editor")).toBeInTheDocument();
    });

    it("renders markdown content in preview mode", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      
      // Switch to preview
      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);
      
      // Check that the markdown is rendered (heading should be present)
      expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();
    });

    it("hides edit button in readOnly mode for markdown files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" readOnly />);
      
      // Edit button should not be visible
      expect(screen.queryByRole("button", { name: /edit mode/i })).not.toBeInTheDocument();
      // Preview button should still be visible
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("defaults to preview mode in readOnly mode for markdown files", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" readOnly />);

      expect(document.querySelector(".cm-editor")).not.toBeInTheDocument();
      expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();
    });

    it("preview button is disabled when already in preview mode", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
      
      // Switch to preview
      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);
      
      // Preview button should now be disabled
      expect(previewButton).toBeDisabled();
    });

    it("edit button is disabled when already in edit mode", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
      
      const editButton = screen.getByRole("button", { name: /edit mode/i });
      // Edit button should be disabled in edit mode
      expect(editButton).toBeDisabled();
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
    it("secondary actions are collapsed by default for markdown and non-markdown files", () => {
      const { rerender } = render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" onToggleLineNumbers={vi.fn()} />);

      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle word wrap/i })).not.toBeInTheDocument();

      rerender(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" onToggleLineNumbers={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle word wrap/i })).not.toBeInTheDocument();
    });

    it("expanding shows line-number and wrap toggles", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" onToggleLineNumbers={vi.fn()} />);

      expandEditorOptions();
      expect(screen.getByRole("button", { name: /toggle line numbers/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /toggle word wrap/i })).toBeInTheDocument();
    });

    it("collapsing hides the toggles again", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" onToggleLineNumbers={vi.fn()} />);

      expandEditorOptions();
      expandEditorOptions();
      expect(screen.queryByRole("button", { name: /toggle line numbers/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /toggle word wrap/i })).not.toBeInTheDocument();
    });

    it("aria-expanded reflects state", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" onToggleLineNumbers={vi.fn()} />);

      const optionsButton = screen.getByRole("button", { name: /toggle editor options/i });
      expect(optionsButton).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(optionsButton);
      expect(optionsButton).toHaveAttribute("aria-expanded", "true");
    });

    it("FN-4480: collapsible region has computed display:none when collapsed", () => {
      const css = loadAllAppCss();
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);

      try {
        render(<FileEditor content="x" onChange={vi.fn()} filePath="script.ts" onToggleLineNumbers={vi.fn()} />);

        const optionsButton = screen.getByRole("button", { name: /toggle editor options/i });
        const controlsId = optionsButton.getAttribute("aria-controls");
        expect(controlsId).toBeTruthy();

        const collapsibleRegion = document.getElementById(controlsId as string);
        expect(collapsibleRegion).toBeTruthy();

        expect(getComputedStyle(collapsibleRegion as HTMLElement).display).toBe("none");

        fireEvent.click(optionsButton);
        expect(getComputedStyle(collapsibleRegion as HTMLElement).display).toBe("inline-flex");

        fireEvent.click(optionsButton);
        expect(getComputedStyle(collapsibleRegion as HTMLElement).display).toBe("none");
      } finally {
        style.remove();
      }
    });
  });

  describe("mobile toolbar CSS", () => {
    it("keeps file editor toolbar action buttons at a shared mobile touch target size", () => {
      const css = loadAllAppCss();
      const selectorIndex = css.indexOf(".file-editor-toolbar-actions .btn");

      expect(selectorIndex).toBeGreaterThanOrEqual(0);

      const mediaIndex = css.lastIndexOf("@media (max-width: 768px)", selectorIndex);
      expect(mediaIndex).toBeGreaterThanOrEqual(0);

      const openBraceIndex = css.indexOf("{", mediaIndex);
      let depth = 1;
      let cursor = openBraceIndex + 1;

      while (cursor < css.length && depth > 0) {
        if (css[cursor] === "{") {
          depth += 1;
        } else if (css[cursor] === "}") {
          depth -= 1;
        }
        cursor += 1;
      }

      const mobileCss = css.slice(openBraceIndex + 1, cursor - 1);

      expect(mobileCss).toMatch(
        /\.file-editor-toolbar-actions\s+\.btn\s*\{[^}]*min-height:\s*var\(--mobile-nav-height\);[^}]*min-width:\s*var\(--mobile-nav-height\);[^}]*\}/,
      );
    });
  });
});
