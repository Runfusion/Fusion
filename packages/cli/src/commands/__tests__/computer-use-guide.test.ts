import { describe, expect, it } from "vitest";
import { COMPUTER_COMMAND_SURFACE, COMPUTER_ERROR_CODES } from "../computer/contract.js";
import { COMPUTER_USE_GUIDE_HEADINGS, renderComputerUseGuide } from "../computer/guide.js";

describe("computer-use guide", () => {
  it("renders synthetic surface values without filtering", () => {
    const guide = renderComputerUseGuide({ probe: { description: "Synthetic command", flags: [{ flag: "--synthetic", valueKind: "string", required: true, description: "Synthetic flag" }] } } as never, ["SYNTHETIC_ERROR"] as never, "9.9.9");
    expect(guide).toContain("fn computer probe");
    expect(guide).toContain("--synthetic");
    expect(guide).toContain("SYNTHETIC_ERROR");
    expect(guide).toContain("v9.9.9");
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(guide).toContain(`## ${heading}`);
  });

  it("renders mutually-exclusive and conditional rules needed to invoke commands", () => {
    const guide = renderComputerUseGuide();
    expect(guide).toContain("mutually exclusive with `--value-stdin`");
    expect(guide).toContain("Supply exactly one of --value or --value-stdin.");
    expect(guide).toContain("Supply exactly one of --text or --text-stdin.");
    expect(guide).toMatch(/### fn computer press-key[\s\S]*?Rules:\n- --snapshot-id and window flags require --element-index\./);
    expect(guide).toContain("Choose exactly one form: all four coordinate flags, or both element-index flags.");
    expect(guide).toContain("Coordinate drag takes no --snapshot-id or window flags.");
    for (const trigger of ["focus changes", "navigation", "scrolling", "re-rendering"]) expect(guide).toContain(trigger);
    expect(guide).toContain("elementCount");
    expect(guide).toContain("consumed-by-action");
    expect(guide).toContain("snapshotConsumed");
  });

  it("is the complete rendering link after descriptor anchors establish the live surface", () => {
    /* FNXC:ComputerUseSkill 2026-08-11-07:19: Guards 1/2b/3 anchor descriptor values to live code;
     * this guard anchors the guide to that descriptor, so together they prove completeness. Alone it
     * proves no drift claim. */
    const guide = renderComputerUseGuide();
    for (const name of Object.keys(COMPUTER_COMMAND_SURFACE)) expect(guide, `missing ${name}`).toContain(`fn computer ${name}`);
    for (const entry of Object.values(COMPUTER_COMMAND_SURFACE)) for (const flag of entry.flags) expect(guide, `missing ${flag.flag}`).toContain(flag.flag);
    for (const code of COMPUTER_ERROR_CODES) expect(guide, `missing ${code}`).toContain(code);
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(guide.match(new RegExp(`## ${heading}`, "g"))?.length, heading).toBe(1);
    expect(guide).not.toMatch(/…|\.\.\.and \d+ more|\[truncated\]/);
  });
});
