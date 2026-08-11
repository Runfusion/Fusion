import { DASHBOARD_USER_ID, type MessageCreateInput, type MessageStore } from "@fusion/core";
import { createLogger } from "../logger.js";

const approvalMailLog = createLogger("approval-mail");

/**
 * FNXC:StructuralMail 2026-08-09-07:16:
 * Pending-approval lookup deliberately re-invokes its pause callbacks, so mailbox delivery is
 * idempotent by approvalRequestId. The write is fail-soft: mailbox persistence must never break
 * the approval pause that protects the gated action.
 */
export async function emitApprovalMail(input: {
  messageStore?: Pick<MessageStore, "sendMessageOnce">;
  approvalRequestId: string;
  toolName: string;
  taskId?: string;
  agentId?: string;
  agentName?: string;
}): Promise<void> {
  try {
    if (!input.messageStore?.sendMessageOnce) return;
    const requester = input.agentName ?? input.agentId ?? "An agent";
    const message: MessageCreateInput = {
      fromId: "system",
      fromType: "system",
      toId: DASHBOARD_USER_ID,
      toType: "user",
      type: "system",
      content: `**Approval required for ${input.toolName}**\n\n${requester} requested approval before this action can continue.`,
      metadata: {
        mailKind: "approval",
        approvalRequestId: input.approvalRequestId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
    };
    await input.messageStore.sendMessageOnce(message, `approval-mail:${input.approvalRequestId}`);
  } catch (error) {
    approvalMailLog.warn(`approval mailbox message failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
