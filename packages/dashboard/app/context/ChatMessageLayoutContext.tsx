import { createContext, useContext, type ReactNode } from "react";
import type { ChatMessageLayout } from "../hooks/useAppSettings";

/**
 * FNXC:ChatMessageLayout 2026-08-18-20:27:
 * One App-level context keeps the project-scoped choice consistent across normal Chat, Quick Chat, dock hosts, task Activity, and Planner Chat without duplicating layout props through each host.
 */
const ChatMessageLayoutContext = createContext<ChatMessageLayout>("bubbles");

export function ChatMessageLayoutProvider({ value, children }: { value: ChatMessageLayout; children: ReactNode }) {
  return <ChatMessageLayoutContext.Provider value={value}>{children}</ChatMessageLayoutContext.Provider>;
}

export function useChatMessageLayout(): ChatMessageLayout {
  return useContext(ChatMessageLayoutContext);
}
