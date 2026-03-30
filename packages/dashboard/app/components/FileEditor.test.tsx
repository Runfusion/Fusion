import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileEditor } from "./FileEditor";

describe("FileEditor", () => {
  it("renders textarea with correct class names", () => {
    render(<FileEditor content="" onChange={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.classList.contains("file-editor-container")).toBe(true);
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
});
