import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve(__dirname, "../styles.css"), "utf-8");

function findHelperTextareaRule(): string {
  const match = css.match(
    /\.terminal-xterm\s+\.xterm\s+\.xterm-helper-textarea\s*\{([^}]*)\}/,
  );
  return match?.[1] ?? "";
}

describe("terminal helper textarea CSS contract", () => {
  it("defines the xterm helper textarea rule", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).not.toBe("");
  });

  it("keeps mobile-friendly helper textarea dimensions", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/width:\s*1px\b/);
    expect(ruleBody).toMatch(/height:\s*1px\b/);
  });

  it("anchors the helper textarea inside the terminal bounds", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/top:\s*0\b/);
    expect(ruleBody).toMatch(/left:\s*0\b/);
  });

  it("prevents direct pointer interaction with the helper textarea", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/pointer-events\s*:\s*none\b/);
  });

  it("keeps the helper textarea effectively invisible", () => {
    const ruleBody = findHelperTextareaRule();
    expect(ruleBody).toMatch(/opacity:\s*0\.01\b/);
  });
});
