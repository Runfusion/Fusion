import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoppedOutNotes } from "../usePoppedOutNotes";

const note = (id: string, title = id) => ({ id, title, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

describe("usePoppedOutNotes", () => {
  it("déduplique par projet et note, relève la fenêtre et conserve son slot", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => result.current.popOut("p1", note("n1")));
    const first = result.current.entries[0];
    act(() => result.current.popOut("p1", note("n1", "Renommée")));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ focusNonce: 2, cascadeSlot: first.cascadeSlot, note: { title: "Renommée" } });
  });

  it("replace une note réactivée en fin d’ordre sans changer son slot", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => result.current.popOut("p1", note("a")));
    const firstSlot = result.current.entries[0].cascadeSlot;
    act(() => result.current.popOut("p1", note("b")));
    act(() => result.current.popOut("p1", note("a", "A réactivée")));

    expect(result.current.entries.map((entry) => entry.note.id)).toEqual(["b", "a"]);
    expect(result.current.entries.at(-1)).toMatchObject({
      focusNonce: 2,
      cascadeSlot: firstSlot,
      note: { title: "A réactivée" },
    });
  });

  it("isole les projets, alloue des slots distincts et ferme précisément", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => {
      result.current.popOut("p1", note("n1"));
      result.current.popOut("p1", note("n2"));
      result.current.popOut("p2", note("n1"));
    });
    expect(result.current.entries).toHaveLength(3);
    expect(result.current.entries.filter((entry) => entry.projectId === "p1").map((entry) => entry.cascadeSlot)).toEqual([0, 1]);
    act(() => result.current.close("p1", "n1"));
    expect(result.current.entries.map((entry) => `${entry.projectId}:${entry.note.id}`)).toEqual(["p1:n2", "p2:n1"]);
  });
});
