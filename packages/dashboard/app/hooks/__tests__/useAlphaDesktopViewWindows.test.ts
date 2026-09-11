import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAlphaDesktopViewWindows } from "../useAlphaDesktopViewWindows";

function setup(enabled = true) {
  const navigation = { pushNav: vi.fn(), removeNav: vi.fn(), promoteNav: vi.fn() };
  const showBoard = vi.fn();
  const showNotesPage = vi.fn();
  const rendered = renderHook(({ active }) => useAlphaDesktopViewWindows({ enabled: active, projectId: "p1", navigation, showBoard, showNotesPage }), { initialProps: { active: enabled } });
  return { ...rendered, navigation, showBoard, showNotesPage };
}

describe("useAlphaDesktopViewWindows", () => {
  it("ouvre chaque identité une fois et réactive sans profondeur supplémentaire", () => {
    const { result, navigation, showBoard } = setup();
    act(() => { result.current.open("patchnode"); result.current.open("patchnode"); result.current.open("notes"); });
    expect(result.current.windows.map(({ id }) => id)).toEqual(["patchnode", "notes"]);
    expect(navigation.pushNav).toHaveBeenCalledTimes(2);
    expect(navigation.promoteNav).toHaveBeenCalledWith("alpha-pilot:patchnode");
    expect(showBoard).toHaveBeenCalledTimes(3);
  });

  it("coalese les fermetures concurrentes et conserve la fenêtre sur Cancel", async () => {
    const { result, navigation } = setup();
    let resolve!: (value: boolean) => void;
    const verdict = new Promise<boolean>((done) => { resolve = done; });
    act(() => { result.current.open("notes"); result.current.registerGuard("notes", () => verdict); });
    let first!: Promise<boolean>; let second!: Promise<boolean>;
    act(() => { first = result.current.requestClose("notes"); second = result.current.requestClose("notes"); });
    expect(first).toBe(second);
    await act(async () => { resolve(false); await first; });
    expect(result.current.windows).toHaveLength(1);
    expect(navigation.removeNav).not.toHaveBeenCalled();
  });

  it("préserve toutes les fenêtres et leur ordre quand Notes annule une fermeture globale", async () => {
    const { result, navigation } = setup();
    const notesGuard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    act(() => {
      result.current.open("notes");
      result.current.open("patchnode");
      result.current.registerGuard("notes", notesGuard);
    });

    await act(async () => { expect(await result.current.requestCloseAll()).toBe(false); });
    expect(result.current.windows.map(({ id }) => id)).toEqual(["notes", "patchnode"]);
    expect(navigation.removeNav).not.toHaveBeenCalled();

    await act(async () => { expect(await result.current.requestCloseAll()).toBe(true); });
    expect(result.current.windows).toEqual([]);
    expect(navigation.removeNav.mock.calls).toEqual([
      ["alpha-pilot:notes", { preserveHistoryPosition: true }],
      ["alpha-pilot:patchnode", { preserveHistoryPosition: true }],
    ]);
  });

  it("revalide la portée avant de supprimer le brouillon ou les fenêtres", async () => {
    const { result, navigation } = setup();
    const discardDraft = vi.fn();
    act(() => {
      result.current.open("notes");
      result.current.open("patchnode");
      result.current.registerGuard("notes", () => true, discardDraft);
    });

    await act(async () => { expect(await result.current.requestCloseAll(() => false)).toBe(false); });
    expect(result.current.windows.map(({ id }) => id)).toEqual(["notes", "patchnode"]);
    expect(discardDraft).not.toHaveBeenCalled();
    expect(navigation.removeNav).not.toHaveBeenCalled();

    await act(async () => { expect(await result.current.requestCloseAll(() => true)).toBe(true); });
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(result.current.windows).toEqual([]);
  });

  it("ferme après Discard et retire l’entrée sans browser back concurrent", async () => {
    const { result, navigation } = setup();
    const discardDraft = vi.fn();
    act(() => { result.current.open("notes"); result.current.registerGuard("notes", () => true, discardDraft); });
    await act(async () => { await result.current.requestClose("notes", { preserveHistoryPosition: true }); });
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(result.current.windows).toEqual([]);
    expect(navigation.removeNav).toHaveBeenCalledWith("alpha-pilot:notes", { preserveHistoryPosition: true });
  });
});
