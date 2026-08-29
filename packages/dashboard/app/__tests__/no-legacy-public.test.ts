import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

describe("legacy public/ directory removal", () => {
  const publicDir = resolve(__dirname, "../../public");

  it("public/style.css does not exist", () => {
    expect(existsSync(resolve(publicDir, "style.css"))).toBe(false);
  });

  it("public/board.js does not exist", () => {
    expect(existsSync(resolve(publicDir, "board.js"))).toBe(false);
  });

  it("public/index.html does not exist", () => {
    expect(existsSync(resolve(publicDir, "index.html"))).toBe(false);
  });

  it("server.ts clientDir resolution does not reference 'public'", () => {
    const serverSrc = readFileSync(
      resolve(__dirname, "../../src/server.ts"),
      "utf-8",
    );
    // Extract the clientDir resolution block (from "const clientDir" to the semicolon)
    const match = serverSrc.match(/const clientDir[\s\S]*?;/);
    expect(match).toBeTruthy();
    expect(match![0]).not.toContain('"public"');
    expect(match![0]).not.toContain("'public'");
  });
});
