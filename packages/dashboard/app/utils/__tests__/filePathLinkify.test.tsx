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
});
