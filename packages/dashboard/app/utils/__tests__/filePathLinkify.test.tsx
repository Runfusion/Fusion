import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { FilePathLink, linkifyFilePaths } from "../filePathLinkify";

describe("filePathLinkify", () => {
  it.each([
    "packages/dashboard/app/App.tsx",
    ".fusion/tasks/FN-4227/PROMPT.md",
    "Dockerfile",
    "src/foo.ts:42",
    "src/foo.ts:42:7",
  ])("matches %s", (value) => {
    const result = linkifyFilePaths(`open ${value} now`);
    expect(result.some((node) => typeof node !== "string")).toBe(true);
  });

  it.each([
    "https://example.com/foo.md",
    "v1.2.3",
    "node_modules",
    "the literal string it.each should stay plain text",
  ])("does not match %s", (value) => {
    const result = linkifyFilePaths(value);
    expect(result).toEqual([value]);
  });

  it("opens the linked file through context", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn();

    render(
      <FileBrowserProvider openFile={openFile}>
        <FilePathLink path="src/foo.ts" line={42} col={7}>src/foo.ts:42:7</FilePathLink>
      </FileBrowserProvider>,
    );

    await user.click(screen.getByRole("button", { name: "src/foo.ts:42:7" }));
    expect(openFile).toHaveBeenCalledWith("src/foo.ts", { line: 42, col: 7 });
  });

  it("allows long file path links to wrap", () => {
    const openFile = vi.fn();

    render(
      <FileBrowserProvider openFile={openFile}>
        <FilePathLink path="packages/some/very/long/nested/path/file.ts">
          packages/some/very/long/nested/path/file.ts
        </FilePathLink>
      </FileBrowserProvider>,
    );

    const button = screen.getByRole("button", {
      name: "packages/some/very/long/nested/path/file.ts",
    });
    const styles = getComputedStyle(button);

    expect(styles.whiteSpace).toBe("normal");
    expect(styles.display).not.toBe("inline-flex");
  });

  it("inherits surrounding text color and left-aligns wrapped path text", () => {
    const openFile = vi.fn();

    render(
      <FileBrowserProvider openFile={openFile}>
        <div style={{ color: "rgb(10, 20, 30)" }}>
          <FilePathLink path="src/foo.ts">src/foo.ts</FilePathLink>
        </div>
      </FileBrowserProvider>,
    );

    const button = screen.getByRole("button", { name: "src/foo.ts" });
    const styles = getComputedStyle(button);

    expect(styles.color).toBe("rgb(10, 20, 30)");
    expect(styles.color).not.toBe("rgb(47, 129, 247)");
    expect(styles.display).toBe("inline");
    expect(styles.display).not.toBe("inline-flex");

    const filePathLinkRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText === ".file-path-link",
      );

    expect(filePathLinkRule).toBeDefined();
    expect(filePathLinkRule?.style.textAlign).toBe("left");
    expect(filePathLinkRule?.style.color).toBe("inherit");
  });
});
