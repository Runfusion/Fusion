import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_SETTINGS,
  isProjectSettingsKey,
  isReviewArtifact,
  isReviewArtifactGenerationEligible,
  LIVE_DEMO_ARTIFACT_MIME_TYPE,
  parseReviewArtifactsModeOverride,
  resolveReviewArtifactsMode,
  type Artifact,
} from "../types.js";

function artifact(type: Artifact["type"], mimeType?: string): Pick<Artifact, "type" | "mimeType"> {
  return { type, mimeType };
}

describe("review artifact policy", () => {
  it("defaults conservatively and registers the project setting", () => {
    expect(DEFAULT_PROJECT_SETTINGS.reviewArtifacts).toBe("off");
    expect(isProjectSettingsKey("reviewArtifacts")).toBe(true);
  });

  it("resolves the persisted PROMPT.md override before project policy", () => {
    expect(parseReviewArtifactsModeOverride("**Review Artifacts:** user-facing")).toBe("user-facing");
    expect(parseReviewArtifactsModeOverride("**Review Artifacts:** ON")).toBe("on");
    expect(resolveReviewArtifactsMode({ reviewArtifacts: "on" }, "**Review Artifacts:** off")).toBe("off");
    expect(resolveReviewArtifactsMode({ reviewArtifacts: "user-facing" })).toBe("user-facing");
    expect(resolveReviewArtifactsMode({})).toBe("off");
  });

  it("gates automatic generation by policy and task classification", () => {
    const userFacingPrompt = "## Frontend UX Criteria\n- visible behavior";
    const backendPrompt = "**Review Artifact Task Type:** backend";
    const trivialPrompt = "**Review Artifact Task Type:** trivial";

    expect(isReviewArtifactGenerationEligible({ reviewArtifacts: "off" }, userFacingPrompt)).toBe(false);
    expect(isReviewArtifactGenerationEligible({ reviewArtifacts: "user-facing" }, userFacingPrompt)).toBe(true);
    expect(isReviewArtifactGenerationEligible({ reviewArtifacts: "user-facing" }, backendPrompt)).toBe(false);
    expect(isReviewArtifactGenerationEligible({ reviewArtifacts: "user-facing" }, trivialPrompt)).toBe(false);
    expect(isReviewArtifactGenerationEligible({ reviewArtifacts: "on" }, trivialPrompt)).toBe(true);
    expect(isReviewArtifactGenerationEligible({ reviewArtifacts: "off" }, "**Review Artifacts:** on\n" + backendPrompt)).toBe(true);
  });

  it("includes videos and explicitly marked live-demo descriptors in review surfaces", () => {
    expect(isReviewArtifact(artifact("video"))).toBe(true);
    expect(isReviewArtifact(artifact("document", LIVE_DEMO_ARTIFACT_MIME_TYPE))).toBe(true);
    expect(isReviewArtifact(artifact("document", `${LIVE_DEMO_ARTIFACT_MIME_TYPE}; charset=utf-8`))).toBe(true);
    expect(isReviewArtifact(artifact("document"))).toBe(false);
    expect(isReviewArtifact(artifact("image"))).toBe(false);
    expect(isReviewArtifact(artifact("audio"))).toBe(false);
    expect(isReviewArtifact(artifact("other"))).toBe(false);
  });
});
