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

  describe("backtracking-linear guard (Firefox `too much recursion` regression)", () => {
    // FNXC:FilePathLinkify 2026-08-21-23:31:
    // Regression guard for the "Something went wrong / too much recursion" crash
    // in the "stash" project chat. The previous FILE_PATH_REGEX was
    // exponentially ambiguous on slash-heavy near-misses (segments could
    // contain "/" themselves); SpiderMonkey's recursive backtracker overflowed
    // the stack while linkifying an ~80KB assistant message, tearing the chat
    // view down through the ErrorBoundary. These inputs complete instantly
    // under the linear regex; if a future edit reintroduces backtracking
    // ambiguity, matchAll stalls here and the test times out instead of
    // shipping another stack overflow.

    it("does not linkify slash-separated id runs (the exact line that crashed Firefox)", () => {
      const value =
        "1. Stash MCP server (STAS-001/002/003/004/005/006/008/015/018/019/020/021/024/025/037/040/041/043/044/045/047/051/052/053/054/055/056/057): the entire FastMCP server, tools (search, vfs, memory, session), Heavi connector, X saves hardening, pi plugin integration, logger SDK…";
      expect(linkifyFilePaths(value)).toEqual([value]);
    });

    it("completes on adversarial slash-heavy input without links", () => {
      const value = "a/".repeat(500) + "b/c";
      expect(linkifyFilePaths(value)).toEqual([value]);
    });

    it.each([
      "https://github.com/user/repo/blob/main/src/file.ts",
      "http://host.com/a/b.ts",
    ])("does not match URL path tails (%s)", (value) => {
      expect(linkifyFilePaths(value)).toEqual([value]);
    });
  });
});
