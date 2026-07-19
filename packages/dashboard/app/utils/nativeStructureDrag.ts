import type { NativeStructureRef } from "@fusion/core";

export const NATIVE_STRUCTURE_DRAG_MIME = "application/x-fusion-native-structure";

const NATIVE_STRUCTURE_KINDS: readonly NativeStructureRef["kind"][] = [
  "mission",
  "milestone",
  "goal",
  "research-finding",
  "eval-result",
];

/**
 * FNXC:NativeStructureEmbed 2026-07-22-10:30:
 * Mail and every native-structure owner exchange this one DataTransfer protocol rather than
 * inventing per-view payloads. It intentionally accepts only the five persisted preview kinds:
 * mission, milestone, goal, research-finding, and eval-result.
 */
export function serializeNativeStructureRef(dataTransfer: DataTransfer, ref: NativeStructureRef): void {
  dataTransfer.setData(NATIVE_STRUCTURE_DRAG_MIME, JSON.stringify(ref));
  dataTransfer.setData("text/plain", `fusion://${ref.kind}/${ref.id}`);
  dataTransfer.effectAllowed = "copy";
}

/** Reads and validates an untrusted browser drag payload. */
export function readNativeStructureRef(dataTransfer: DataTransfer): NativeStructureRef | null {
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(NATIVE_STRUCTURE_DRAG_MIME));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !NATIVE_STRUCTURE_KINDS.includes((parsed as NativeStructureRef).kind) ||
      typeof (parsed as NativeStructureRef).id !== "string" ||
      !(parsed as NativeStructureRef).id.trim() ||
      ((parsed as NativeStructureRef).projectId !== undefined && typeof (parsed as NativeStructureRef).projectId !== "string")
    ) {
      return null;
    }
    const { kind, id, projectId } = parsed as NativeStructureRef;
    return projectId === undefined ? { kind, id } : { kind, id, projectId };
  } catch {
    return null;
  }
}

/** True only for drags emitted by serializeNativeStructureRef. */
export function hasNativeStructureDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(NATIVE_STRUCTURE_DRAG_MIME);
}

/** Native HTML dragging on touch-primary devices competes with scrolling; use the composer picker there. */
export function isNativeStructureDragEnabled(): boolean {
  return typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches;
}
