import { describe, expect, it } from "vitest";
import { formatPiExtensionSource } from "../pi-extensions.js";

describe("formatPiExtensionSource", () => {
  it("formats project-relative extension paths", () => {
    expect(
      formatPiExtensionSource(
        "fusion-project",
        "/repo/.fusion/extensions/tooling/index.ts",
        "/repo",
        "/Users/alice",
      ),
    ).toBe("fusion-project: .fusion/extensions/tooling/index.ts");
  });

  it("formats home-relative Windows extension paths", () => {
    expect(
      formatPiExtensionSource(
        "fusion-global",
        "C:\\Users\\alice\\.fusion\\agent\\extensions\\tooling\\index.ts",
        "C:\\repo",
        "C:\\Users\\alice",
      ),
    ).toBe("fusion-global: ~/.fusion/agent/extensions/tooling/index.ts");
  });

  it("does not treat prefix-matching sibling paths as inside the project or home", () => {
    const projectLookalike = "C:\\repo-two\\.fusion\\extensions\\tooling\\index.ts";
    const homeLookalike = "C:\\Users\\alice-dev\\.fusion\\agent\\extensions\\tooling\\index.ts";

    expect(
      formatPiExtensionSource("fusion-project", projectLookalike, "C:\\repo", "C:\\Users\\alice"),
    ).toBe(`fusion-project: ${projectLookalike}`);
    expect(
      formatPiExtensionSource("fusion-global", homeLookalike, "C:\\repo", "C:\\Users\\alice"),
    ).toBe(`fusion-global: ${homeLookalike}`);
  });
});
