import type { NativeStructurePreviewResult, NativeStructureRef } from "@fusion/core";

export const NATIVE_STRUCTURE_OPEN_EVENT = "fusion:native-structure-open";

export interface NativeStructureOpenEventDetail {
  ref: NativeStructureRef;
  payload: NativeStructurePreviewResult;
}

/**
 * FNXC:NativeStructureEmbed 2026-07-19-19:30:
 * StandardChatSurface is shared by room, task-bound, floating, and dock chat, so its preview
 * callback crosses this narrow event boundary instead of adding navigation forks to each host.
 * App owns translating the foundation's callback/view-state target into the active dashboard view.
 */
export function openNativeStructure(ref: NativeStructureRef, payload: NativeStructurePreviewResult): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<NativeStructureOpenEventDetail>(NATIVE_STRUCTURE_OPEN_EVENT, {
    detail: { ref, payload },
  }));
}
