import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("FileBrowser.css token contract", () => {
  it("does not use deprecated --radius alias token", async () => {
    const cssPath = new URL("../FileBrowser.css", import.meta.url);
    const css = await readFile(cssPath, "utf8");
    expect(css).not.toMatch(/var\(--radius\)/);
  });
});
