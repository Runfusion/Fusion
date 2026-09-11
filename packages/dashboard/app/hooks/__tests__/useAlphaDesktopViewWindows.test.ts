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
  it("conserve History comme seule identité de fenêtre et la réactive sans profondeur", () => {
    const { result, navigation, showBoard } = setup();
    act(() => { result.current.open("patchnode"); result.current.open("patchnode"); });
    expect(result.current.windows.map(({ id }) => id)).toEqual(["patchnode"]);
    expect(navigation.pushNav).toHaveBeenCalledTimes(1);
    expect(navigation.promoteNav).toHaveBeenCalledWith("alpha-pilot:patchnode");
    expect(showBoard).toHaveBeenCalledTimes(2);
  });

  it("coalesce les fermetures concurrentes et conserve History sur Cancel", async () => {
    const { result, navigation } = setup();
    let resolve!: (value: boolean) => void;
    const verdict = new Promise<boolean>((done) => { resolve = done; });
    act(() => { result.current.open("patchnode"); result.current.registerGuard("patchnode", () => verdict); });
    let first!: Promise<boolean>; let second!: Promise<boolean>;
    act(() => { first = result.current.requestClose("patchnode"); second = result.current.requestClose("patchnode"); });
    expect(first).toBe(second);
    await act(async () => { resolve(false); await first; });
    expect(result.current.windows).toHaveLength(1);
    expect(navigation.removeNav).not.toHaveBeenCalled();
  });

  it("protège le brouillon Notes inline pendant une fermeture globale", async () => {
    const { result, navigation } = setup();
    const notesGuard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const discardDraft = vi.fn();
    act(() => {
      result.current.open("patchnode");
      result.current.registerGuard("notes", notesGuard, discardDraft);
    });

    await act(async () => { expect(await result.current.requestCloseAll()).toBe(false); });
    expect(result.current.windows.map(({ id }) => id)).toEqual(["patchnode"]);
    expect(navigation.removeNav).not.toHaveBeenCalled();
    expect(discardDraft).not.toHaveBeenCalled();

    await act(async () => { expect(await result.current.requestCloseAll()).toBe(true); });
    expect(result.current.windows).toEqual([]);
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(navigation.removeNav).toHaveBeenCalledWith("alpha-pilot:patchnode", { preserveHistoryPosition: true });
  });

  it("retire explicitement la garde Notes quand son hôte Alpha desktop disparaît", async () => {
    const { result } = setup();
    const staleGuard = vi.fn().mockResolvedValue(false);
    const staleDiscard = vi.fn();
    act(() => {
      result.current.registerGuard("notes", staleGuard, staleDiscard);
      result.current.clearGuard("notes");
    });

    await act(async () => { expect(await result.current.requestCloseAll()).toBe(true); });
    expect(staleGuard).not.toHaveBeenCalled();
    expect(staleDiscard).not.toHaveBeenCalled();
  });

  it("revalide la portée avant de supprimer le brouillon inline", async () => {
    const { result, navigation } = setup();
    const discardDraft = vi.fn();
    act(() => {
      result.current.open("patchnode");
      result.current.registerGuard("notes", () => true, discardDraft);
    });

    await act(async () => { expect(await result.current.requestCloseAll(() => false)).toBe(false); });
    expect(result.current.windows.map(({ id }) => id)).toEqual(["patchnode"]);
    expect(discardDraft).not.toHaveBeenCalled();
    expect(navigation.removeNav).not.toHaveBeenCalled();

    await act(async () => { expect(await result.current.requestCloseAll(() => true)).toBe(true); });
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(result.current.windows).toEqual([]);
  });
});
