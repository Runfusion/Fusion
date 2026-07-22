import { describe, expect, it } from "vitest";
import { validateMessageMetadata } from "../types.js";

describe("validateMessageMetadata nativeStructures", () => {
  it("accepts absent, single, and multiple supported structural embeds", () => {
    expect(() => validateMessageMetadata(undefined)).not.toThrow();
    expect(() => validateMessageMetadata({ nativeStructures: [{ kind: "mission", id: "M-1" }] })).not.toThrow();
    expect(() => validateMessageMetadata({
      nativeStructures: [
        { kind: "goal", id: "G-1", label: "Ship mail embeds" },
        { kind: "eval-result", id: "E-1", projectId: "project-1" },
      ],
    })).not.toThrow();
  });

  /*
  FNXC:CoreTests 2026-07-20-23:40:
  `roadmap-item` is a supported native structure kind (plugin-resolved). Invalid-kind coverage
  uses an unknown kind instead of a now-valid value so the allowlist regression stays meaningful.
  */
  it.each([
    [{ nativeStructures: "not-an-array" }, "must be an array"],
    [{ nativeStructures: [{ kind: "mission" }] }, "id must be a non-empty string"],
    [{ nativeStructures: [{ kind: "unknown", id: "X-1" }] }, "kind is invalid"],
    [{ nativeStructures: [{ kind: "goal", id: "G-1", label: 1 }] }, "label must be a string"],
  ])("rejects invalid native structures %#", (metadata, message) => {
    expect(() => validateMessageMetadata(metadata as never)).toThrow(message);
  });

  it("accepts roadmap-item native structure embeds", () => {
    expect(() => validateMessageMetadata({
      nativeStructures: [{ kind: "roadmap-item", id: "R-1" }],
    })).not.toThrow();
  });
});
