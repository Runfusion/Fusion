import { vi } from "vitest";

/*
FNXC:ChatStreamingTestStorage 2026-09-17-00:00:
ChatView's rendered streaming path reaches both the general scoped-storage helpers and the persisted
open-session helpers through useChat. Keep this complete test-double at one shared boundary so new
session-restoration reads cannot make otherwise unrelated streaming assertions fail at module load.
*/
export const mockProjectStorage = {
  getScopedItem: vi.fn<(baseKey: string, projectId?: string) => string | null | undefined>(),
  setScopedItem: vi.fn<(baseKey: string, value: string, projectId?: string) => boolean>(),
  removeScopedItem: vi.fn<(baseKey: string, projectId?: string) => void>(),
  getPersistedChatOpenSession: vi.fn<(projectId?: string) => string | null>(),
  setPersistedChatOpenSession: vi.fn<(sessionId: string, projectId?: string) => void>(),
  clearPersistedChatOpenSession: vi.fn<(projectId?: string) => void>(),
};
