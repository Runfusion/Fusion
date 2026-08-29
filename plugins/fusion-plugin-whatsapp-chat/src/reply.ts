import type { PluginContext } from "@fusion/plugin-sdk";
import { getSettingString, type ChatTurn } from "./index.js";

export async function generateReply(ctx: PluginContext, _sender: string, text: string, history: ChatTurn[]): Promise<string> {
  if (!ctx.createAiSession) {
    throw new Error("AI session factory unavailable: engine not registered");
  }

  const systemPrompt = getSettingString(ctx.settings, "agentSystemPrompt") ?? "You are a helpful assistant replying in WhatsApp chats.";
  const sessionResult = await ctx.createAiSession({
    cwd: ctx.taskStore.getRootDir(),
    systemPrompt,
    tools: "readonly",
  });

  const promptLines = [
    "Continue this WhatsApp conversation.",
    ...history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`),
    `User: ${text}`,
    "Assistant:",
  ];

  await sessionResult.session.prompt(promptLines.join("\n"));
  const assistantMessages = sessionResult.session.state.messages.filter((message) => message.role === "assistant");
  const latest = assistantMessages[assistantMessages.length - 1];
  const content = latest?.content;

  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") ? (part as { text: string }).text : "")
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join("\n").trim();
  }

  throw new Error("AI session returned no assistant text");
}
