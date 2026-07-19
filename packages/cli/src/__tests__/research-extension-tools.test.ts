/**
 * FNXC:MergeQueue 2026-07-15-11:28:
 * Host extension no longer registers fn_research_*. This file locks that surface off so dual-store
 * research tools cannot reappear and wedge agent sessions (FN-7956 hang class). Engine createResearchTools
 * remains the gated research agent surface when experimentalFeatures.researchView is enabled.
 */

import { expect, it } from "vitest";
import { createMockApi, registerExtension } from "./pg-extension-harness.js";

const RESEARCH_EXTENSION_TOOLS = [
  "fn_research_run",
  "fn_research_list",
  "fn_research_get",
  "fn_research_cancel",
  "fn_research_retry",
] as const;

it("does not register fn_research_* tools on the host pi extension", () => {
  const api = createMockApi();
  registerExtension(api);
  for (const name of RESEARCH_EXTENSION_TOOLS) {
    expect(api.tools.has(name)).toBe(false);
  }
});
