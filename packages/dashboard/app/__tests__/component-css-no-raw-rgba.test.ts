import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const componentsDir = resolve(__dirname, "..", "components");

function stripVarFallbackRgba(content: string): string {
  return content.replace(/var\([^()]*,\s*rgba?\([^)]*\)\s*\)/g, "");
}

function findComponentCssFiles(dir = componentsDir): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = entries.flatMap((entry) => {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      return findComponentCssFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".css") ? [entryPath] : [];
  });

  return files.sort((left, right) =>
    relative(componentsDir, left).localeCompare(relative(componentsDir, right))
  );
}

function formatComponentCssPath(filePath: string): string {
  return relative(componentsDir, filePath).split(sep).join("/");
}

function findRawRgbViolations(source: string, fileName: string): string[] {
  const withoutFallbacks = stripVarFallbackRgba(source);
  const lines = withoutFallbacks.split(/\r?\n/);

  return lines.flatMap((line, index) =>
    /rgba?\(/.test(line) ? [`${fileName}:${index + 1}:${line.trim()}`] : []
  );
}

function findRawRgbViolationsIncludingFallbacks(source: string, fileName: string): string[] {
  const lines = source.split(/\r?\n/);

  return lines.flatMap((line, index) =>
    /rgba?\(/.test(line) ? [`${fileName}:${index + 1}:${line.trim()}`] : []
  );
}

function buildRawRgbFailureMessage(violations: string[]): string {
  return [
    "Raw rgb/rgba() found in component CSS.",
    "Use design tokens or color-mix(in srgb, var(--color-X) N%, transparent) instead:",
    ...violations,
  ].join("\n");
}

describe("component CSS color token hygiene", () => {
  it("detects raw rgb/rgba calls but permits var() fallback rgb/rgba", () => {
    const source = [
      ".clean { color: var(--color-text); }",
      ".fallback { color: var(--custom-color, rgba(1, 2, 3, 0.5)); }",
      ".violation { box-shadow: 0 0 0 1px rgba(1, 2, 3, 0.5); }",
    ].join("\n");

    const violations = findRawRgbViolations(source, "fixture.css");

    expect(violations).toEqual([
      "fixture.css:3:.violation { box-shadow: 0 0 0 1px rgba(1, 2, 3, 0.5); }",
    ]);
    expect(buildRawRgbFailureMessage(violations)).toContain(
      "fixture.css:3:.violation { box-shadow: 0 0 0 1px rgba(1, 2, 3, 0.5); }"
    );
    expect(buildRawRgbFailureMessage(violations)).toContain(
      "color-mix(in srgb, var(--color-X) N%, transparent)"
    );
  });

  it("contains no raw rgb/rgba calls outside var() fallbacks", () => {
    const cssFiles = findComponentCssFiles();

    const violations = cssFiles.flatMap((filePath) =>
      findRawRgbViolations(readFileSync(filePath, "utf8"), formatComponentCssPath(filePath))
    );

    expect(violations, buildRawRgbFailureMessage(violations)).toEqual([]);
  });

  it("contains no raw rgb/rgba calls anywhere in command-center component CSS", () => {
    /*
    FNXC:CommandCenterStyling 2026-06-18-00:00:
    Command Center has a stricter invariant than the global guard: raw rgb/rgba is forbidden even inside var() fallbacks because undefined surface/border tokens must keep concrete-hex color-mix fallbacks. Use the recursive component CSS scan because loadAllAppCss() only includes top-level components/*.css and does not load command-center subdirectories.
    */
    const cssFiles = findComponentCssFiles().filter((filePath) =>
      formatComponentCssPath(filePath).startsWith("command-center/")
    );

    const violations = cssFiles.flatMap((filePath) =>
      findRawRgbViolationsIncludingFallbacks(
        readFileSync(filePath, "utf8"),
        formatComponentCssPath(filePath)
      )
    );

    expect(violations, buildRawRgbFailureMessage(violations)).toEqual([]);
  });
});
