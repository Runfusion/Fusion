/*
FNXC:PluginThemeContract 2026-07-23-01:21:
The integrator-facing token inventory is a curated stability promise, not an informal example list.
Guard its marker block against missing CSS definitions and keep the documented overlay primitive,
stack synchronizer, HTML mount point, and plugin-authoring cross-reference wired together.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

const CONTRACT_START = "<!-- fusion-theme-token-contract:start -->";
const CONTRACT_END = "<!-- fusion-theme-token-contract:end -->";

/** Slice the marker-delimited token table out of the dashboard guide, failing loudly if either marker is missing. */
function extractContractBlock(guide: string): string {
  const startIndex = guide.indexOf(CONTRACT_START);
  const endIndex = guide.indexOf(CONTRACT_END);

  expect(startIndex, "dashboard guide is missing the theme-token contract start marker").toBeGreaterThanOrEqual(0);
  expect(endIndex, "dashboard guide is missing the theme-token contract end marker").toBeGreaterThan(startIndex);

  return guide.slice(startIndex + CONTRACT_START.length, endIndex);
}

/** Escape a token name for use inside a RegExp so `--border` cannot match `--border-subtle`. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("stable dashboard theme token contract", () => {
  it("keeps every documented token backed by dashboard CSS", () => {
    const guide = readFileSync(resolve(__dirname, "../../../../docs/dashboard-guide.md"), "utf-8");
    const contractBlock = extractContractBlock(guide);
    const documentedTokens = [...contractBlock.matchAll(/`(--[a-z0-9-]+)`/g)].map((match) => match[1]);
    const uniqueTokens = new Set(documentedTokens);

    expect(uniqueTokens.size, "theme-token contract inventory must contain at least 30 distinct tokens").toBeGreaterThanOrEqual(30);
    expect(documentedTokens, "theme-token contract must not document the same token twice").toHaveLength(uniqueTokens.size);

    const css = loadAllAppCss();
    const missingDefinitions = [...uniqueTokens].filter((token) => {
      const definition = new RegExp(`(^|[^-\\w])${escapeRegex(token)}\\s*:`, "m");
      return !definition.test(css);
    });

    expect(
      missingDefinitions,
      `documented stable tokens without CSS definitions: ${missingDefinitions.join(", ") || "none"}`,
    ).toEqual([]);
    expect(uniqueTokens.has("--fusion-max-z"), "layering token must remain part of the stable contract").toBe(true);
  });

  it("keeps the live layering implementation and plugin documentation connected", () => {
    const stackSource = readFileSync(resolve(__dirname, "../components/floatingWindowStack.ts"), "utf-8");
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf-8");
    const pluginGuide = readFileSync(resolve(__dirname, "../../../../docs/PLUGIN_AUTHORING.md"), "utf-8");

    expect(stackSource).toContain("--fusion-max-z");
    expect(indexHtml).toContain('id="plugin-overlay-root"');
    expect(pluginGuide).toContain("--fusion-max-z");
    expect(pluginGuide).toContain("plugin-overlay-root");
    expect(pluginGuide).toContain("dashboard-guide.md");
  });
});
