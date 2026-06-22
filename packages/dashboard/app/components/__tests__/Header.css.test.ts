import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "../Header.css"), "utf8");

function extractRuleBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Missing selector ${selector}`);
  }

  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unterminated selector ${selector}`);
}

describe("Header CSS", () => {
  it("keeps the dashboard top header divider visible by default", () => {
    const block = extractRuleBlock(css, ".header");

    expect(block).toContain("background: var(--surface);");
    expect(block).toContain("border-bottom: 1px solid var(--border);");
  });
});
