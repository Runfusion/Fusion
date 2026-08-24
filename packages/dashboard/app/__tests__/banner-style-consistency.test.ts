import { describe, expect, it } from "vitest";
import { loadComponentCss } from "../test/cssFixture";

const bannerCss = [
  "Banner.css", "TestModeBanner.css", "MigrationInProgressBanner.css", "SqliteMigrationBanner.css",
  "EngineUnavailableBanner.css", "EngineStatusBanner.css", "OAuthReloginBanner.css", "SessionNotificationBanner.css",
  "CliBinaryInstallBanner.css", "UpdateAvailableBanner.css", "MergeAdvanceNotice.css", "TaskIdIntegrityBanner.css",
  "DbCorruptionBanner.css", "SetupWarningBanner.css", "ApprovalNotificationBanner.css", "CapacityRiskBanner.css",
];

function stripVarCalls(line: string): string { return line.replace(/var\([^)]*\)/g, ""); }

describe("dashboard banner style consistency", () => {
  it("keeps accent borders and raw CSS lengths out of banner styles", () => {
    for (const file of bannerCss) {
      const css = loadComponentCss(file);
      expect(css, file).not.toMatch(/border-(?:left|inline-start)\s*:/);
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|rgba\(/i);

      // px is permitted only in media conditions, zero values, and var() fallbacks.
      const offending = css.split(/\r?\n/).filter((line) => !line.includes("@media") && /\d+(?:\.\d+)?px/.test(stripVarCalls(line)));
      expect(offending, `${file} has raw px declaration values`).toEqual([]);
    }
  });
});
