import { describe, expect, it, vi } from "vitest";
import { createSendMessageTool } from "../agent-tools.js";

const execute = async (params: Record<string, unknown>, parent?: Record<string, unknown>) => {
  const sendMessage = vi.fn(async () => ({ id: "msg-1" }));
  const tool = createSendMessageTool({ sendMessage, getMessage: vi.fn(async () => parent ?? null) } as never, "agent-a");
  return { result: await tool.execute("1", params as never), sendMessage };
};
const text = (result: any) => result.content[0].text as string;

describe("fn_send_message structural mail", () => {
  it("persists report metadata and merges a reply reference", async () => {
    const report = { title: "Brief", sections: [{ heading: "Summary", body: "Done" }] };
    const { result, sendMessage } = await execute({ to_id: "dashboard", type: "agent-to-user", content: "See report", mail_kind: "report", report });
    expect(text(result)).toContain("Message sent");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: { mailKind: "report", report } }));
    const reply = await execute({ content: "See report", reply_to_message_id: "parent", mail_kind: "report", report }, { fromId: "dashboard", fromType: "user", toId: "agent-a", toType: "agent" });
    expect(reply.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: { replyTo: { messageId: "parent" }, mailKind: "report", report } }));
  });
  it("keeps plain sends metadata-free", async () => {
    const { sendMessage } = await execute({ to_id: "agent-b", content: "hello" });
    expect(sendMessage).toHaveBeenCalledWith(expect.not.objectContaining({ metadata: expect.anything() }));
  });
  it.each([
    { to_id: "agent-b", content: "x", mail_kind: "report" },
    { to_id: "agent-b", content: "x", report: { title: " ", sections: [{ heading: "H", body: "B" }] } },
    { to_id: "agent-b", content: "x", report: { title: "T", sections: [] } },
    { to_id: "agent-b", content: "x", report: { title: "T", sections: [{ heading: " ", body: "B" }] } },
    { to_id: "agent-b", content: "x", mail_kind: "approval" },
  ])("rejects malformed structural input", async (params) => {
    const { result, sendMessage } = await execute(params);
    expect(text(result)).toMatch(/^ERROR:/); expect(sendMessage).not.toHaveBeenCalled();
  });
});
