import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import realEnApp from "../../../i18n/locales/en/app.json";

/*
 * FNXC:TaskStats 2026-07-01-00:00:
 * Invariant guard for issue #1863. A dashboard component that calls
 * `t("some.key")` where `some.key` resolves to a NESTED OBJECT (not a leaf
 * string) makes i18next return "key 'some.key (en)' returned an object instead
 * of string" and crashes that view's render. Three surfaces hit this class:
 * the Task Stats "Execution mode" row, the Routing tab source label, and the
 * Node Detail Docker host label. The bug is invisible to component tests
 * because the shared test i18n bundle only carries a handful of keys, so calls
 * fall through to their inline English defaults instead of resolving the object.
 *
 * This test scans the real dashboard source against the real en/app.json so a
 * new object-key-as-string caller fails here regardless of test-bundle gaps.
 */

// Dotted paths under the `app` namespace whose value is an object (non-leaf).
function collectObjectKeyPaths(obj: unknown, prefix: string, out: Set<string>): void {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
  if (prefix) out.add(prefix);
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    collectObjectKeyPaths(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

describe("dashboard i18n string-context callers", () => {
  it("never calls t() with a key that resolves to a nested object", () => {
    const objectKeyPaths = new Set<string>();
    collectObjectKeyPaths(realEnApp, "", objectKeyPaths);

    const appDir = resolve(__dirname, "..");
    const files: string[] = [];
    collectSourceFiles(appDir, files);

    // Match `t("dotted.key"` where the leading char is not part of another
    // identifier (so `getT(`, `handleSort(`, `params.set(` are excluded).
    const callRe = /(?<![\w$.])t\(\s*["']([\w.]+)["']/g;
    const violations: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = callRe.exec(text)) !== null) {
        const key = match[1];
        if (!objectKeyPaths.has(key)) continue;
        // `t(key, opts)` with returnObjects:true intentionally reads the object.
        const tail = text.slice(match.index, match.index + 200);
        if (/returnObjects\s*:\s*true/.test(tail)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${file.slice(appDir.length + 1)}:${line} → t("${key}") resolves to an object`);
      }
    }

    expect(violations, `Object-valued i18n keys used in string context:\n${violations.join("\n")}`).toEqual([]);
  });
});
