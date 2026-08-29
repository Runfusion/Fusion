import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("dashboard chat send-message registration", () => {
  it("forwards ChatManager's AgentStore to the messaging tool factory", async () => {
    const source = await readFile(fileURLToPath(new URL("../chat.ts", import.meta.url)), "utf8");

    expect(source).toContain("createSendMessageTool(this.messageStore, agent.id, { agentStore: this.agentStore })");
  });
});
