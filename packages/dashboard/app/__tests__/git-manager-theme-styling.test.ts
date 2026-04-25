import { describe, it, expect, beforeAll } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import fs from "fs";
import path from "path";

describe("Git Manager light-theme tokenization", () => {
  let css: string;

  beforeAll(() => {
    css = loadAllAppCss();
  });

  function getGitManagerLightBlock(): string {
    const startMarker = "/* ── Light Theme Overrides ── */";
    const endMarker = "/* ── Task Changes Tab Styles";

    const startIdx = css.indexOf(startMarker);
    const endIdx = css.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      throw new Error("Could not locate Git Manager light-theme override block boundaries");
    }

    return css.slice(startIdx, endIdx);
  }

  it("uses semantic neutral surface tokens for scoped Git Manager light-theme backgrounds", () => {
    const block = getGitManagerLightBlock();

    expect(block).toContain('[data-theme="light"] .gm-sidebar {\n  background: var(--surface-subtle);');
    expect(block).toContain('[data-theme="light"] .gm-nav-item:hover {\n  background: var(--surface-hover);');
    expect(block).toContain('[data-theme="light"] .gm-commit-header:hover {\n  background: var(--surface-muted);');
    expect(block).toContain('[data-theme="light"] .gm-hash {\n  background: var(--surface-emphasis);');
    expect(block).toContain('[data-theme="light"] .gm-icon-btn:hover {\n  background: var(--surface-hover-strong);');
  });

  it("does not reintroduce direct neutral rgba(0,0,0,0.02-0.06) backgrounds in scoped Git Manager light-theme rules", () => {
    const block = getGitManagerLightBlock();

    expect(block).not.toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.0[2-6]\)/);
  });

  it("uses token-based accent states for selected/default Git Manager light-theme rules", () => {
    const block = getGitManagerLightBlock();

    expect(block).toContain("color-mix(in srgb, var(--todo) 8%, transparent)");
    expect(block).toContain("color-mix(in srgb, var(--todo) 12%, transparent)");
    expect(block).toContain("color-mix(in srgb, var(--todo) 10%, transparent)");
    expect(block).toContain("color: var(--todo);");

    expect(block).not.toContain("rgba(9, 105, 218");
    expect(block).not.toContain("#0969da");
  });
});
