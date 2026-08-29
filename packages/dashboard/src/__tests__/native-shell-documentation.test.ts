// @vitest-environment node

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("native shell documentation contract", () => {
  it("publishes the canonical native shell guide with required flow sections", () => {
    const nativeShellGuide = readDoc("docs/native-shell.md");

    expect(nativeShellGuide).toContain("# Native Shell Connection Guide");
    expect(nativeShellGuide).toContain("## First-run onboarding flow");
    expect(nativeShellGuide).toContain("## QR scan and manual fallback");
    expect(nativeShellGuide).toContain("## Saved connection profiles");
    expect(nativeShellGuide).toContain("## Desktop remote handoff behavior");
    expect(nativeShellGuide).toContain("window.fusionShell");
    expect(nativeShellGuide).toContain("Remote Access runbook");
  });

  it("keeps cross-doc links to the canonical guide and bridge API discoverable", () => {
    const docsIndex = readDoc("docs/README.md");
    const dashboardGuide = readDoc("docs/dashboard-guide.md");
    const mobileGuide = readDoc("MOBILE.md");
    const architecture = readDoc("docs/architecture.md");

    expect(docsIndex).toContain("[Native Shell Connection Guide](./native-shell.md)");
    expect(dashboardGuide).toContain("[Native Shell Connection Guide](./native-shell.md)");
    expect(mobileGuide).toContain("[Native Shell Connection Guide](./docs/native-shell.md)");

    expect(architecture).toContain("window.fusionShell");
    expect(architecture).toContain("getState()");
    expect(architecture).toContain("listProfiles()");
    expect(architecture).toContain("saveProfile(profile)");
    expect(architecture).toContain("deleteProfile(profileId)");
    expect(architecture).toContain("setActiveProfile(profileId)");
    expect(architecture).toContain("setDesktopMode(mode)");
    expect(architecture).toContain("startQrScan()");
    expect(architecture).toContain("openConnectionManager()");
    expect(architecture).toContain("subscribe(listener)");
    expect(architecture).toContain("getDesktopModeState()");
  });
});
