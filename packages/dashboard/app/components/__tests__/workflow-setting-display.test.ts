import { describe, expect, it } from "vitest";

import type { WorkflowSettingDefinition } from "../../api";
import { getWorkflowSettingDisplay, groupWorkflowSettings } from "../workflow-setting-display";

describe("workflow setting display ownership", () => {
  it("does not classify title summarizer keys as workflow model settings", () => {
    const titleSettings: WorkflowSettingDefinition[] = [
      { id: "titleSummarizerProvider", name: "Title summarizer provider", type: "string" },
      { id: "titleSummarizerModelId", name: "Title summarizer model", type: "string" },
      { id: "titleSummarizerFallbackProvider", name: "Title summarizer fallback provider", type: "string" },
      { id: "titleSummarizerFallbackModelId", name: "Title summarizer fallback model", type: "string" },
    ];

    for (const setting of titleSettings) {
      expect(getWorkflowSettingDisplay(setting)).toMatchObject({
        group: "advanced",
        label: setting.name,
      });
    }

    expect(groupWorkflowSettings(titleSettings)).toEqual([{ group: "advanced", settings: titleSettings }]);
  });
});
