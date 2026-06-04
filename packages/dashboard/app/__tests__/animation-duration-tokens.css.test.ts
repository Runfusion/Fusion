import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";

/**
 * Transition tokens (--transition-fast/normal/slow/instant) bundle a duration
 * AND an easing keyword (e.g. "0.3s ease"). They are only valid where the
 * `transition` shorthand expects that pair.
 *
 * Reusing them as bare durations inside `animation` shorthands silently kills
 * the animation: substituting "0.3s ease" next to an explicit easing keyword
 * (`linear`, `ease-in-out`, ...) produces two <easing-function> values, which
 * makes the whole declaration invalid at computed-value time — the browser
 * resolves it to `animation: none` with no console error. Wrapping the token
 * in `calc()` fails the same way (you cannot multiply "0.3s ease").
 *
 * This froze 14 dashboard spinners/pulses (FN-5855/FN-5913 follow-up).
 * Animation durations must use the duration-only tokens (--duration-*).
 */

const APP_DIR = resolve(__dirname, "..");

function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...collectCssFiles(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

const EASING_KEYWORD =
  /\b(?:linear|ease(?:-in|-out|-in-out)?|cubic-bezier\(|steps\()/;

function findViolations(css: string): string[] {
  const violations: string[] = [];
  const lines = css.split("\n");

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    // calc() over a duration+easing pair is always invalid.
    if (/calc\(\s*var\(--transition-/.test(line)) {
      violations.push(`line ${lineNo}: calc() over a transition token — ${line.trim()}`);
      return;
    }

    // animation shorthand: a transition token plus an explicit easing keyword
    // substitutes to two easing functions and invalidates the declaration.
    const animationMatch = line.match(/animation\s*:\s*([^;}]*)/);
    if (animationMatch && /var\(--transition-/.test(animationMatch[1])) {
      const valueWithoutToken = animationMatch[1].replace(/var\(--transition-[a-z]+\)/g, "");
      if (EASING_KEYWORD.test(valueWithoutToken)) {
        violations.push(
          `line ${lineNo}: transition token + explicit easing in animation shorthand — ${line.trim()}`,
        );
      }
    }

    // animation-duration longhand cannot hold "0.3s ease" either.
    if (/animation-duration\s*:\s*[^;}]*var\(--transition-/.test(line)) {
      violations.push(`line ${lineNo}: transition token as animation-duration — ${line.trim()}`);
    }
  });

  return violations;
}

describe("animation duration tokens", () => {
  const cssFiles = collectCssFiles(APP_DIR);

  it("finds the app stylesheets", () => {
    expect(cssFiles.length).toBeGreaterThan(10);
  });

  it("defines duration-only tokens alongside the transition tokens", () => {
    const styles = readFileSync(resolve(APP_DIR, "styles.css"), "utf8");
    for (const speed of ["instant", "fast", "normal", "slow"]) {
      expect(styles).toMatch(new RegExp(`--duration-${speed}:\\s*[\\d.]+m?s\\s*;`));
      // Transition tokens must stay derived from the duration tokens so the
      // two cannot drift apart.
      expect(styles).toMatch(
        new RegExp(`--transition-${speed}:\\s*var\\(--duration-${speed}\\)\\s+ease\\s*;`),
      );
    }
  });

  it("never uses duration+easing transition tokens where a bare duration is required", () => {
    const allViolations: string[] = [];

    for (const file of cssFiles) {
      const css = readFileSync(file, "utf8");
      const violations = findViolations(css);
      for (const violation of violations) {
        allViolations.push(`${relative(APP_DIR, file)} ${violation}`);
      }
    }

    expect(allViolations).toEqual([]);
  });

  it("flags the frozen-spinner pattern if it is reintroduced", () => {
    expect(findViolations(".x { animation: spin var(--transition-slow) linear infinite; }")).toHaveLength(1);
    expect(findViolations(".x { animation: spin calc(var(--transition-slow) * 4) linear infinite; }")).toHaveLength(1);
    expect(findViolations(".x { animation-duration: var(--transition-slow); }")).toHaveLength(1);
    // Valid: token used in transition shorthand, or animation without a second easing.
    expect(findViolations(".x { transition: color var(--transition-fast); }")).toHaveLength(0);
    expect(findViolations(".x { animation: fadeIn var(--duration-fast) ease-out; }")).toHaveLength(0);
  });
});
