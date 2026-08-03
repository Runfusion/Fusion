import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");
const agentsPath = resolve(rootDir, "AGENTS.md");
const agents = readFileSync(agentsPath, "utf8");

const requiredAnchors = [
  "Port 4040",
  "pnpm release",
  "@runfusion/fusion",
  'engineModule = "@fusion/engine"',
  "superviseSpawn",
  "Fusion-Task-Id",
  "Merging Branches Into Main",
  "autoMerge: false",
  "File-Scope invariant",
  "git add -f",
];

test("AGENTS.md keeps non-negotiable invariant anchors", () => {
  for (const anchor of requiredAnchors) {
    assert.ok(agents.includes(anchor), `Missing required anchor: ${anchor}`);
  }
});

test("Merging section retains at least 10 numbered rules", () => {
  const heading = "### Merging Branches Into Main";
  const start = agents.indexOf(heading);
  assert.notEqual(start, -1, "Merging section heading missing");

  const afterStart = agents.slice(start + heading.length);
  const nextSection = afterStart.indexOf("\n### ");
  const section = nextSection === -1 ? afterStart : afterStart.slice(0, nextSection);

  const rules = section.match(/^\d+\.\s+/gm) ?? [];
  assert.ok(rules.length >= 10, `Expected >= 10 numbered rules, found ${rules.length}`);
});

test("All ./docs/*.md links in AGENTS.md resolve", () => {
  const matches = [...agents.matchAll(/\.\/docs\/[A-Za-z0-9._-]+\.md/g)].map((m) => m[0]);
  const links = [...new Set(matches)];
  assert.ok(links.length > 0, "No ./docs/*.md links found");

  for (const link of links) {
    const target = resolve(rootDir, link);
    assert.ok(existsSync(target), `Broken docs link in AGENTS.md: ${link}`);
  }
});
