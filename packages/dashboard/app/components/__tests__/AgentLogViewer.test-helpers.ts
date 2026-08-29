// FNXC:DashboardTests 2026-06-25-19:31: Shared fixtures for AgentLogViewer.*.test.tsx — split from AgentLogViewer.test.tsx to drop under the 2000-line guard (FN-7028, see FN-7013).
import type { AgentLogEntry } from "@fusion/core";

export function makeEntry(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    taskId: "FN-001",
    text: "Hello world",
    type: "text",
    ...overrides,
  };
}

export function getScrollContainer(container: HTMLElement): HTMLDivElement {
  return container.querySelector(".agent-log-viewer-scroll") as HTMLDivElement;
}
