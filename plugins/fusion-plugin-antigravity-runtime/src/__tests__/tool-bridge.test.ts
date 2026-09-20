import { describe, expect, it } from "vitest";
import { toolsToMcpToolDefs } from "../tool-bridge.js";

describe("Antigravity Fusion tool bridge", () => {
  it("publishes only executable fn tools supplied by the engine", () => {
    expect(toolsToMcpToolDefs([
      { name: "fn_task_list", description: "list", execute: async () => [] },
      { name: "fn_forged" },
      { name: "shell_exec", execute: async () => undefined },
    ])).toEqual([{ name: "fn_task_list", description: "list", inputSchema: { type: "object", properties: {} } }]);
  });
});
