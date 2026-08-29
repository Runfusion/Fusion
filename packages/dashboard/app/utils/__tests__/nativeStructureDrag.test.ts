import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeStructureRef } from "@fusion/core";
import { attachNativeStructureRefToDrag, hasNativeStructureDrag, isNativeStructureDragEnabled, NATIVE_STRUCTURE_DRAG_MIME, readNativeStructureRef, serializeNativeStructureRef } from "../nativeStructureDrag";

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

const refsByKind: { [Kind in NativeStructureRef["kind"]]: NativeStructureRef & { kind: Kind } } = {
  mission: { kind: "mission", id: "M-1" },
  milestone: { kind: "milestone", id: "MS-1" },
  goal: { kind: "goal", id: "G-1" },
  "research-finding": { kind: "research-finding", id: "INS-1" },
  "eval-result": { kind: "eval-result", id: "E-1" },
  "roadmap-item": { kind: "roadmap-item", id: "F-1" },
};
const refs = Object.values(refsByKind);

describe("nativeStructureDrag", () => {
  afterEach(() => vi.unstubAllGlobals());

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
    unsupported.setData(NATIVE_STRUCTURE_DRAG_MIME, JSON.stringify({ kind: "unknown", id: "R-1" }));
    expect(readNativeStructureRef(missing)).toBeNull();
    expect(readNativeStructureRef(malformed)).toBeNull();
    expect(readNativeStructureRef(unsupported)).toBeNull();
  });

  it("attaches a native payload without replacing an existing reorder payload", () => {
    const dataTransfer = transfer();
    dataTransfer.setData("text/plain", "feature:F-1");
    dataTransfer.effectAllowed = "move";

    expect(attachNativeStructureRefToDrag(dataTransfer, refsByKind["roadmap-item"])).toBe(true);
    expect(dataTransfer.getData("text/plain")).toBe("feature:F-1");
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(hasNativeStructureDrag(dataTransfer)).toBe(true);
  });

  it("does not attach native payloads on coarse pointers", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const dataTransfer = transfer();
    dataTransfer.setData("text/plain", "feature:F-1");

    expect(isNativeStructureDragEnabled()).toBe(false);
    expect(attachNativeStructureRefToDrag(dataTransfer, refsByKind["roadmap-item"])).toBe(false);
    expect(dataTransfer.getData(NATIVE_STRUCTURE_DRAG_MIME)).toBe("");
    expect(dataTransfer.getData("text/plain")).toBe("feature:F-1");
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
