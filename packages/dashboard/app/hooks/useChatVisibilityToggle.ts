/*
FNXC:ChatWindows 2026-09-02-05:24:
Nothing open opens one chat; anything visible minimizes every visible chat; everything minimized restores exactly the set captured by the last minimize, at the same position.
*/
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ChatVisibilityToggleAction = "open-quick-chat" | "minimize-all" | "restore-all";

export interface ChatVisibilityToggleState {
  quickChatOpen: boolean;
  quickChatMinimized: boolean;
  poppedOutChatEntries: readonly { minimized: boolean }[];
}

export function resolveChatVisibilityToggleAction(state: ChatVisibilityToggleState): ChatVisibilityToggleAction {
  if (state.quickChatOpen || state.poppedOutChatEntries.some((entry) => !entry.minimized)) {
    return "minimize-all";
  }
  if (state.quickChatMinimized || state.poppedOutChatEntries.some((entry) => entry.minimized)) {
    return "restore-all";
  }
  return "open-quick-chat";
}

export function shouldCloseQuickChatOnOutsideClick(options: {
  quickChatCloseOnOutsideClick: boolean;
  poppedOutChatEntries: readonly { minimized: boolean }[];
}): boolean {
  return options.quickChatCloseOnOutsideClick
    && options.poppedOutChatEntries.every((entry) => entry.minimized);
}

export interface UseChatVisibilityToggleOptions {
  quickChatOpen: boolean;
  setQuickChatOpen: Dispatch<SetStateAction<boolean>>;
  poppedOutChatEntries: readonly { minimized: boolean }[];
  minimizeAllPoppedOutChats: () => void;
  restoreAllPoppedOutChats: () => void;
}

export interface UseChatVisibilityToggleResult {
  action: ChatVisibilityToggleAction;
  toggle: () => void;
  reset: () => void;
}

export function useChatVisibilityToggle({
  quickChatOpen,
  setQuickChatOpen,
  poppedOutChatEntries,
  minimizeAllPoppedOutChats,
  restoreAllPoppedOutChats,
}: UseChatVisibilityToggleOptions): UseChatVisibilityToggleResult {
  const [quickChatMinimized, setQuickChatMinimized] = useState(false);
  const action = resolveChatVisibilityToggleAction({
    quickChatOpen,
    quickChatMinimized,
    poppedOutChatEntries,
  });

  const toggle = useCallback(() => {
    if (action === "minimize-all") {
      setQuickChatMinimized(quickChatOpen);
      setQuickChatOpen(false);
      minimizeAllPoppedOutChats();
      return;
    }
    if (action === "restore-all") {
      if (quickChatMinimized) setQuickChatOpen(true);
      setQuickChatMinimized(false);
      restoreAllPoppedOutChats();
      return;
    }
    setQuickChatMinimized(false);
    setQuickChatOpen(true);
  }, [
    action,
    minimizeAllPoppedOutChats,
    quickChatMinimized,
    quickChatOpen,
    restoreAllPoppedOutChats,
    setQuickChatOpen,
  ]);

  const reset = useCallback(() => setQuickChatMinimized(false), []);

  return { action, toggle, reset };
}
