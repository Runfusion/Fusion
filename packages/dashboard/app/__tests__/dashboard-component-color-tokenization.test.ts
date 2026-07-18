import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStylesCss } from "../test/cssFixture";

const root = resolve(__dirname, "../components");

const auditedCompliant = ["ChatView.css", "MobileNavBar.css", "ListView.css", "WorkflowResultsTab.css"];
const cleanedFiles = [
  "AgentReflectionsTab.css",
  "CliBinaryInstallBanner.css",
  "CliBinaryPanel.css",
  "FileMentionPopup.css",
  "GitHubImportModal.css",
  "InlineCreateCard.css",
  "LanguageSelector.css",
  "PullRequestView.css",
  "ScriptsModal.css",
  "SettingsFieldRow.css",
  "SettingsSyncLog.css",
  "WorkflowFieldsPanel.css",
  "WorkflowNodeEditor.css",
  "WorkflowSettingsPanel.css",
  "WorkspaceSelector.css",
];

const bareHexCleanedFiles = ["ScriptsModal.css", "SettingsSyncLog.css"];
const hexLiteralPattern = /#[0-9a-fA-F]{3,8}\b/;

function resolveComponentCss(file: string): string {
  const directPath = resolve(root, file);
  if (existsSync(directPath)) {
    return directPath;
  }

  return resolve(root, "settings", file);
}

function stripVarCalls(line: string): string {
  return line.replace(/var\([^)]*\)/g, "");
}

function extractRootBlock(css: string): string {
  const rootRegex = /:root\s*\{/g;
  let match;
  let secondRootIdx = -1;
  let count = 0;

  while ((match = rootRegex.exec(css)) !== null) {
    count++;
    if (count === 2) {
      secondRootIdx = match.index;
      break;
    }
  }

  if (secondRootIdx === -1) {
    throw new Error("Could not find second :root block");
  }

  return extractBlockAt(css, secondRootIdx);
}

function extractLightThemeBlock(css: string): string {
  const startMatch = css.match(/:root\[data-theme="light"\]\s*\{/);
  if (!startMatch) {
    throw new Error("Could not find :root[data-theme=\"light\"] block");
  }

  return extractBlockAt(css, startMatch.index!);
}

function extractBlockAt(css: string, startIdx: number): string {
  const openBraceIdx = startIdx + css.slice(startIdx).indexOf("{");
  let depth = 1;
  let end = openBraceIdx;

  for (let i = openBraceIdx + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }

  return css.slice(startIdx, end + 1);
}

function extractTokenDefinition(block: string, token: string): string {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escapedToken}:\\s*([^;]+);`));
  if (!match) {
    throw new Error(`Could not find ${token} definition`);
  }

  return match[1].trim();
}

describe("dashboard surface token definitions", () => {
  it("defines neutral surface and subtle border tokens in base and light themes", () => {
    const css = loadStylesCss();
    const rootBlock = extractRootBlock(css);
    const lightThemeBlock = extractLightThemeBlock(css);
    const tokens = ["--surface-1", "--surface-2", "--border-subtle"];

    /*
     FNXC:DashboardSurfaceTokens 2026-06-18-21:29:
     FN-6678 keeps these tokens defined in both canonical theme blocks because charts, Command Center surfaces, areas, and NewTaskModal consume them through bare var() calls with no fallback. Require color-mix token derivations so removing a definition or replacing it with a raw color fails the guard.
    */
    for (const token of tokens) {
      const rootDefinition = extractTokenDefinition(rootBlock, token);
      const lightDefinition = extractTokenDefinition(lightThemeBlock, token);

      expect(rootDefinition, `${token} must be defined in :root`).toMatch(/^color-mix\(in\s+srgb,/);
      expect(lightDefinition, `${token} must be defined in :root[data-theme="light"]`).toMatch(/^color-mix\(in\s+srgb,/);
      expect(rootDefinition, `${token} root definition must not use raw colors`).not.toMatch(/rgba\(|#[0-9a-fA-F]{3,8}/);
      expect(lightDefinition, `${token} light definition must not use raw colors`).not.toMatch(/rgba\(|#[0-9a-fA-F]{3,8}/);
    }
  });
});

describe("dashboard component color tokenization", () => {
  it("keeps audited compliant files free of raw rgba()", () => {
    for (const file of auditedCompliant) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/rgba\(/);
    }
  });

  it("keeps cleaned files free of raw rgba()", () => {
    for (const file of cleanedFiles) {
      const source = readFileSync(resolveComponentCss(file), "utf8");
      expect(source).not.toMatch(/rgba\(/);
    }
  });

  it("keeps cleaned files free of bare hex outside var() fallbacks", () => {
    for (const file of bareHexCleanedFiles) {
      const source = readFileSync(resolve(root, file), "utf8");
      const linesWithBareHex = source
        .split(/\r?\n/)
        .map((line, index) => ({ index: index + 1, strippedLine: stripVarCalls(line) }))
        .filter(({ strippedLine }) => hexLiteralPattern.test(strippedLine));

      expect(linesWithBareHex, `${file} has bare hex colors outside var() fallbacks`).toEqual([]);
    }
  });

  it("keeps CustomModelDropdown free of raw rgba()", () => {
    const source = readFileSync(resolve(root, "CustomModelDropdown.css"), "utf8");
    expect(source).not.toMatch(/rgba\(/);
  });
});
