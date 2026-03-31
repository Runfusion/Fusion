import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileEditor } from "./FileEditor";

describe("FileEditor", () => {
  it("renders textarea with correct class names", () => {
    render(<FileEditor content="" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.classList.contains("file-editor-textarea")).toBe(true);
  });

  it("renders with content prop value", () => {
    const content = "const x = 42;";
    render(<FileEditor content={content} onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe(content);
  });

  it("calls onChange when text is modified", () => {
    const onChange = vi.fn();
    render(<FileEditor content="" onChange={onChange} />);
    const textarea = screen.getByRole("textbox");
    
    fireEvent.change(textarea, { target: { value: "new content" } });
    
    expect(onChange).toHaveBeenCalledWith("new content");
  });

  it("respects readOnly prop", () => {
    render(<FileEditor content="readonly content" onChange={vi.fn()} readOnly />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
  });

  it("has correct aria-label based on filePath prop", () => {
    const filePath = "src/components/App.tsx";
    render(<FileEditor content="" onChange={vi.fn()} filePath={filePath} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("aria-label")).toBe(`Editor for ${filePath}`);
  });

  it("has default aria-label when filePath is not provided", () => {
    render(<FileEditor content="" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("aria-label")).toBe("File editor");
  });

  it("has spellCheck disabled", () => {
    render(<FileEditor content="" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
  });

  it("is not readOnly by default", () => {
    render(<FileEditor content="" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
  });

  describe("markdown preview", () => {
    it("shows edit/preview toggle for .md files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
      
      expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("shows edit/preview toggle for .markdown files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.markdown" />);
      
      expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("shows edit/preview toggle for .mdx files", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="page.mdx" />);
      
      expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("does not show edit/preview toggle for non-markdown files", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
    });

    it("does not show edit/preview toggle when filePath is not provided", () => {
      render(<FileEditor content="some content" onChange={vi.fn()} />);
      
      expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /preview/i })).not.toBeInTheDocument();
    });

    it("defaults to edit mode for markdown files", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      
      // Textarea should be visible
      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect(textarea.tagName.toLowerCase()).toBe("textarea");
    });

    it("switches to preview mode when preview button is clicked", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      
      // Click preview button
      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);
      
      // Preview should be visible (no textarea)
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(document.querySelector(".file-editor-preview")).toBeInTheDocument();
    });

    it("switches back to edit mode when edit button is clicked", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      
      // Switch to preview first
      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);
      
      // Then switch back to edit
      const editButton = screen.getByRole("button", { name: /edit/i });
      fireEvent.click(editButton);
      
      // Textarea should be visible again
      const textarea = screen.getByRole("textbox");
      expect(textarea).toBeInTheDocument();
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
      expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
      // Preview button should still be visible
      expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    });

    it("defaults to preview mode in readOnly mode for markdown files", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" readOnly />);
      
      // Preview should be active by default (no textarea in readOnly)
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
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
      
      const editButton = screen.getByRole("button", { name: /edit/i });
      // Edit button should be disabled in edit mode
      expect(editButton).toBeDisabled();
    });
  });

  describe("word wrap toggle", () => {
    it("shows word wrap toggle button for markdown files in edit mode", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" />);
      
      expect(screen.getByRole("button", { name: /toggle word wrap/i })).toBeInTheDocument();
    });

    it("shows word wrap toggle button for non-markdown files", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      expect(screen.getByRole("button", { name: /toggle word wrap/i })).toBeInTheDocument();
    });

    it("does not show word wrap toggle button in readOnly mode", () => {
      render(<FileEditor content="# Hello" onChange={vi.fn()} filePath="readme.md" readOnly />);
      
      expect(screen.queryByRole("button", { name: /toggle word wrap/i })).not.toBeInTheDocument();
    });

    it("word wrap is enabled by default", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      const textarea = screen.getByRole("textbox");
      expect(textarea.classList.contains("file-editor-textarea--wrap")).toBe(true);
    });

    it("toggle button shows active state when word wrap is enabled", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      expect(wrapButton.classList.contains("btn-primary")).toBe(true);
    });

    it("clicking toggle button disables word wrap", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      fireEvent.click(wrapButton);
      
      const textarea = screen.getByRole("textbox");
      expect(textarea.classList.contains("file-editor-textarea--wrap")).toBe(false);
    });

    it("clicking toggle button again re-enables word wrap", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      fireEvent.click(wrapButton); // turn off
      fireEvent.click(wrapButton); // turn on
      
      const textarea = screen.getByRole("textbox");
      expect(textarea.classList.contains("file-editor-textarea--wrap")).toBe(true);
    });

    it("toggle button loses active state when word wrap is disabled", () => {
      render(<FileEditor content="const x = 1;" onChange={vi.fn()} filePath="script.ts" />);
      
      const wrapButton = screen.getByRole("button", { name: /toggle word wrap/i });
      fireEvent.click(wrapButton);
      
      expect(wrapButton.classList.contains("btn-primary")).toBe(false);
    });
  });

  describe("markdown preview scrollability", () => {
    it("preview container has correct CSS classes for scrolling", () => {
      render(<FileEditor content="# Hello World" onChange={vi.fn()} filePath="readme.md" />);
      
      // Switch to preview mode
      const previewButton = screen.getByRole("button", { name: /preview/i });
      fireEvent.click(previewButton);
      
      const preview = document.querySelector(".file-editor-preview");
      expect(preview).toBeInTheDocument();
      // The class includes scrollable styles: flex: 1, min-height: 0, overflow-y: auto
      expect(preview?.classList.contains("file-editor-preview")).toBe(true);
    });
  });
});
