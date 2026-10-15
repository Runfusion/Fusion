/*
WHY A NEW FILE: the pi extension is the surface agent sessions actually call, and its tool text is
doubly derived — a hand-written registration plus generated skill-catalog docs. No existing test asserted
that a description change reached BOTH halves, which is precisely how a caveat could silently disappear:
`scripts/sync-fusion-skill-tools.mjs` extracts only double-quoted string literals, so an imported constant
regenerates the catalog with the sentence gone.
*/
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TASK_BOARD_READ_CAVEAT } from "@fusion/core";

/**
 * FNXC:BoardReadToolDescriptions 2026-10-15-00:01 (RUFU-378):
 * `fn_task_list` rows show a label truncated from the card's intake description, and pi-side duplicate
 * checks were answering from that stub. The caveat must reach the pi registration AND the generated
 * skill catalog, because the generated docs are what an agent reads before it calls the tool.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionSource = (): string => readFileSync(resolve(__dirname, "../extension.ts"), "utf8");
const generatedDoc = (file: string): string =>
  readFileSync(resolve(__dirname, "../../skill/fusion/references", file), "utf8");

/** The generator normalizes whitespace when it renders a description; compare on the same footing. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The `description:` expression text of one `pi.registerTool({ name: "..." })` block. */
function registeredDescription(source: string, toolName: string): string {
  const block = source.match(
    new RegExp(`name: "${toolName}"[\\s\\S]*?description:([\\s\\S]*?),\\s*\\n\\s*(promptSnippet|parameters):`),
  );
  expect(block, `pi registration for ${toolName} must expose a description`).not.toBeNull();
  return collapse(block![1]);
}

describe("RUFU-378 pi board-read caveat reaches models and the tracked catalog", () => {
  it("is embedded in the pi fn_task_list registration as a double-quoted literal", () => {
    // Structural, not prose: the catalog generator extracts double-quoted literals only, so swapping in
    // the imported constant would ship a pi tool whose description is `undefined` at extraction time.
    const description = registeredDescription(extensionSource(), "fn_task_list");
    expect(description).toContain(TASK_BOARD_READ_CAVEAT);
    expect(description).not.toContain("TASK_BOARD_READ_CAVEAT");
  });

  it.each(["extension-tools.md", "fusion-capabilities.md"])(
    "lands in the generated %s the skill ships",
    (file) => {
      const doc = collapse(generatedDoc(file));
      expect(doc).toContain(TASK_BOARD_READ_CAVEAT);
      expect(doc.match(new RegExp(TASK_BOARD_READ_CAVEAT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    },
  );

  it("names fn_task_show as the resolution step in every rendering", () => {
    expect(registeredDescription(extensionSource(), "fn_task_list")).toContain("fn_task_show");
    for (const file of ["extension-tools.md", "fusion-capabilities.md"]) {
      expect(collapse(generatedDoc(file))).toContain("Call fn_task_show");
    }
  });
});
