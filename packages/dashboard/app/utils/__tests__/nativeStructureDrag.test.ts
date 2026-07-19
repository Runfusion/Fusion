import { describe, expect, it } from "vitest";
import type { NativeStructureRef } from "@fusion/core";
import { hasNativeStructureDrag, NATIVE_STRUCTURE_DRAG_MIME, readNativeStructureRef, serializeNativeStructureRef } from "../nativeStructureDrag";

function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    types: [] as unknown as DOMStringList,
    effectAllowed: "none",
    setData(type: string, value: string) {
      data.set(type, value);
      (this.types as unknown as string[]) = [...data.keys()];
    },
    getData(type: string) {
      return data.get(type) ?? "";
    },
  } as unknown as DataTransfer;
}

const refs: NativeStructureRef[] = [
  { kind: "mission", id: "M-1" },
  { kind: "milestone", id: "MS-1" },
  { kind: "goal", id: "G-1" },
  { kind: "research-finding", id: "INS-1" },
  { kind: "eval-result", id: "E-1" },
];

describe("nativeStructureDrag", () => {
  it.each(refs)("round-trips $kind references", (ref) => {
    const dataTransfer = transfer();
    serializeNativeStructureRef(dataTransfer, ref);
    expect(readNativeStructureRef(dataTransfer)).toEqual(ref);
    expect(dataTransfer.getData("text/plain")).toBe(`fusion://${ref.kind}/${ref.id}`);
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("rejects missing or malformed payloads", () => {
    const missing = transfer();
    const malformed = transfer();
    malformed.setData(NATIVE_STRUCTURE_DRAG_MIME, "not json");
    const unsupported = transfer();
    unsupported.setData(NATIVE_STRUCTURE_DRAG_MIME, JSON.stringify({ kind: "roadmap-item", id: "R-1" }));
    expect(readNativeStructureRef(missing)).toBeNull();
    expect(readNativeStructureRef(malformed)).toBeNull();
    expect(readNativeStructureRef(unsupported)).toBeNull();
  });

  it("guards only its own custom MIME type", () => {
    const nativeDrag = transfer();
    nativeDrag.setData(NATIVE_STRUCTURE_DRAG_MIME, JSON.stringify(refs[0]));
    const fileDrag = transfer();
    fileDrag.setData("text/plain", "file");
    expect(hasNativeStructureDrag(nativeDrag)).toBe(true);
    expect(hasNativeStructureDrag(fileDrag)).toBe(false);
  });
});
