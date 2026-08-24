import { describe, expect, it } from "vitest";
import { loadAllAppCssBaseOnly } from "../test/cssFixture";

const css = loadAllAppCssBaseOnly();

function getSelectorBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m");
  const match = css.match(pattern);
  expect(match, `Expected ${selector} CSS block to exist`).not.toBeNull();
  return match?.[1] ?? "";
}

/*
FNXC:DashboardStyling 2026-08-23-22:40:
FN-9202 moved the sticky top-banner stacking onto the shared `.banner--chrome` shell, expressed as a
design token rather than a literal, so this contract resolves `var(--<token>)` through its `:root`
definition. A dangling token would otherwise read as "no z-index" — which is exactly the defect that
shipped with the unification.
*/
function getSelectorZIndex(selector: string): number {
  const block = getSelectorBlock(selector);
  const match = block.match(/z-index:\s*(?:var\((--[\w-]+)\)|(\d+))/);
  expect(match, `Expected ${selector} to define a z-index`).not.toBeNull();
  if (match?.[2]) return Number(match[2]);
  const token = match![1];
  const tokenMatch = css.match(new RegExp(`${token}:\\s*(\\d+)\\s*;`));
  expect(tokenMatch, `Expected ${selector}'s ${token} token to be defined`).not.toBeNull();
  return Number(tokenMatch?.[1]);
}

describe("onboarding overlay layering contract (FN-2397)", () => {
  it("keeps modal overlays above sticky top banners", () => {
    const modalOverlayZ = getSelectorZIndex(".modal-overlay");
    // The session banner renders through the shared chrome banner shell, which owns the stacking.
    const sessionBannerZ = getSelectorZIndex(".banner--chrome");

    expect(modalOverlayZ).toBeGreaterThan(sessionBannerZ);
  });

  it("keeps the onboarding resume banner in normal document flow", () => {
    const onboardingResumeBlock = getSelectorBlock(".onboarding-resume-card");

    expect(onboardingResumeBlock).not.toMatch(/position:\s*sticky/);
    expect(onboardingResumeBlock).not.toMatch(/top:\s*0/);
  });
});
