// Regression guard for FN-4286/FN-6688: prevent reintroducing undefined primary/secondary text aliases.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadStylesCss } from "../test/cssFixture";

const APP_ROOT = path.resolve(__dirname, "..");
const ALLOWLIST = new Set([
  "__tests__/text-token-canonicalization.test.ts",
  "__tests__/agent-css-classes.test.ts",
]);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const fullPath = path.join(dir, entry);
    const relPath = path.relative(APP_ROOT, fullPath).split(path.sep).join("/");
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (/\.(css|tsx?|ts)$/.test(entry)) out.push(relPath);
  }
  return out;
}

describe("text token canonicalization", () => {
  it("keeps --text-secondary out of dashboard source files", () => {
    const offenders: string[] = [];
    for (const relPath of collectSourceFiles(APP_ROOT)) {
      if (ALLOWLIST.has(relPath)) continue;
      const content = readFileSync(path.join(APP_ROOT, relPath), "utf8");
      if (content.includes("--text-secondary")) offenders.push(relPath);
    }

    expect(offenders, `Unexpected --text-secondary references in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps --text-primary out of dashboard source files outside command-center", () => {
    const offenders: string[] = [];
    for (const relPath of collectSourceFiles(APP_ROOT)) {
      if (relPath.startsWith("components/command-center/")) continue;
      if (ALLOWLIST.has(relPath)) continue;
      const content = readFileSync(path.join(APP_ROOT, relPath), "utf8");
      if (content.includes("--text-primary")) offenders.push(relPath);
    }

    expect(offenders, `Unexpected --text-primary references in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("defines canonical text tokens and does not define legacy text aliases at :root", () => {
    const stylesCss = loadStylesCss();
    const rootBlocks = [...stylesCss.matchAll(/:root\s*\{([\s\S]*?)\}/g)].map((match) => match[1]);
    expect(rootBlocks.length).toBeGreaterThan(0);
    const allRootContent = rootBlocks.join("\n");

    expect(allRootContent).not.toMatch(/^\s*--text-primary\s*:/m);
    expect(allRootContent).not.toMatch(/^\s*--text-secondary\s*:/m);
    expect(allRootContent).toMatch(/^\s*--text\s*:/m);
    expect(allRootContent).toMatch(/^\s*--text-muted\s*:/m);
    expect(allRootContent).toMatch(/^\s*--text-dim\s*:/m);
  });
});
