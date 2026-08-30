import {describe, expect, it} from "vitest";
import {decideTaskPromptRefresh} from "../taskPromptRefresh";

describe("decideTaskPromptRefresh", () => {
  it("adopts populated responses, including a shorter rewrite", () => {
    expect(decideTaskPromptRefresh({
      retainedPrompt: "# Long plan\n\nMany details that were removed",
      responsePrompt: "# Short plan",
    })).toEqual({action: "adopt", prompt: "# Short plan"});
  });

  it.each([
    ["an absent response", undefined],
    ["an empty response", ""],
    ["a whitespace-only response", " \n\t "],
  ])("retains a loaded plan for %s", (_label, responsePrompt) => {
    expect(decideTaskPromptRefresh({
      retainedPrompt: "# Loaded plan",
      responsePrompt,
    })).toEqual({action: "retain"});
  });

  it.each([undefined, "", " \n\t "])("adopts empty when neither side has a plan (%j)", (responsePrompt) => {
    expect(decideTaskPromptRefresh({
      retainedPrompt: undefined,
      responsePrompt,
    })).toEqual({action: "adopt-empty"});
  });
});
