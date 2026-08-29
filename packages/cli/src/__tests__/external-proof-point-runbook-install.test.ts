import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const runbookPath = resolve(workspaceRoot, "docs", "plugins", "external-proof-point-runbook.md");
const authoringPath = resolve(workspaceRoot, "docs", "plugins", "external-authoring.md");

const rawTarballInstallPattern = /fn plugin install\s+\S*\.tgz\b/;

/*
FNXC:Plugins 2026-06-15-02:57:
FN-6474 guards the packaged-install proof path after FN-6471 showed raw tarballs are rejected as non-JS file entrypoints. Keep this test static and docs-only so the runbook cannot regress without invoking the real CLI or network.
*/
describe("external plugin proof-point packaged install docs", () => {
  it("does not tell readers to install a raw tarball in the runbook", () => {
    const runbook = readFileSync(runbookPath, "utf8");

    expect(runbook).not.toMatch(rawTarballInstallPattern);
  });

  it("extracts the packed tarball before installing the unpacked package directory", () => {
    const runbook = readFileSync(runbookPath, "utf8");
    const packIndex = runbook.indexOf("pnpm pack");
    const extractIndex = runbook.indexOf("tar -xzf fusion-plugin-proof-point-plugin-0.1.0.tgz");
    const installIndex = runbook.indexOf("fn plugin install ./package");

    expect(packIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(packIndex);
    expect(installIndex).toBeGreaterThan(extractIndex);
  });

  it("keeps the authoring guide from installing raw tarballs", () => {
    const authoringGuide = readFileSync(authoringPath, "utf8");

    expect(authoringGuide).not.toMatch(rawTarballInstallPattern);
    expect(authoringGuide).toContain("tar -xzf fusion-plugin-my-plugin-0.1.0.tgz");
    expect(authoringGuide).toContain("fn plugin install ./package");
  });
});
