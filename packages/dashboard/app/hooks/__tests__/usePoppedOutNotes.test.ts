import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoppedOutNotes } from "../usePoppedOutNotes";

const note = (id: string, title = id) => ({ id, title, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
/*
FNXC:ProjectNotes 2026-09-15-03:29:
FN-404 : l’adoption d’un renommage externe se décide sur l’identité rendue (`id`, `title`, `revision`, `updatedAt`),
donc toute fixture nouvelle est un `ProjectNoteSummary` complet.
*/
const live = (id: string, title: string, revision: number, updatedAt = "2026-01-01T00:00:00.000Z") => ({ id, title, revision, createdAt: "2026-01-01T00:00:00.000Z", updatedAt });

describe("usePoppedOutNotes", () => {
  it("déduplique par projet et note, relève la fenêtre", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => result.current.popOut("p1", note("n1")));
    const first = result.current.entries[0];
    act(() => result.current.popOut("p1", note("n1", "Renommée")));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ focusNonce: first.focusNonce + 1, note: { title: "Renommée" } });
  });

  it("replace une note réactivée en fin d’ordre sans changer son slot", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => result.current.popOut("p1", note("a")));
    act(() => result.current.popOut("p1", note("b")));
    act(() => result.current.popOut("p1", note("a", "A réactivée")));

    expect(result.current.entries.map((entry) => entry.note.id)).toEqual(["b", "a"]);
    expect(result.current.entries.at(-1)).toMatchObject({
      focusNonce: 2,
      note: { title: "A réactivée" },
    });
  });

  it("syncNote réécrit l’instantané en place sans toucher focusNonce ni l’ordre d’activation", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => {
      result.current.popOut("p1", live("n1", "Première", 1));
      result.current.popOut("p1", live("n2", "Deuxième", 1));
    });
    const nonces = result.current.entries.map((entry) => entry.focusNonce);

    act(() => result.current.syncNote("p1", live("n1", "Renommée", 2, "2026-01-02T00:00:00.000Z")));

    expect(result.current.entries.map((entry) => entry.note.id)).toEqual(["n1", "n2"]);
    expect(result.current.entries.map((entry) => entry.focusNonce)).toEqual(nonces);
    expect(result.current.entries[0].note).toMatchObject({ title: "Renommée", revision: 2 });
    expect(result.current.entries[1].note.title).toBe("Deuxième");
  });

  it("syncNote ignore une note inconnue ou d’un autre projet en préservant l’identité du tableau", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => result.current.popOut("p1", live("n1", "Première", 1)));
    const before = result.current.entries;

    act(() => {
      result.current.syncNote("p1", live("absente", "Fantôme", 9));
      result.current.syncNote("p2", live("n1", "Autre projet", 9));
    });

    expect(result.current.entries).toBe(before);
    expect(result.current.entries[0].note.title).toBe("Première");
  });

  it("syncNote n’écrit rien quand l’identité rendue est inchangée", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => result.current.popOut("p1", live("n1", "Première", 1)));
    const before = result.current.entries;

    act(() => result.current.syncNote("p1", live("n1", "Première", 1)));

    expect(result.current.entries).toBe(before);
  });

  it("syncNote isole deux projets portant le même identifiant de note", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => {
      result.current.popOut("p1", live("n1", "Projet A", 1));
      result.current.popOut("p2", live("n1", "Projet B", 1));
    });

    act(() => result.current.syncNote("p2", live("n1", "Projet B renommé", 2, "2026-01-02T00:00:00.000Z")));

    expect(result.current.entries.map((entry) => `${entry.projectId}:${entry.note.title}`)).toEqual([
      "p1:Projet A",
      "p2:Projet B renommé",
    ]);
    expect(result.current.entries.map((entry) => entry.focusNonce)).toEqual([1, 1]);
  });

  it("isole les projets et ferme précisément", () => {
    const { result } = renderHook(() => usePoppedOutNotes());
    act(() => {
      result.current.popOut("p1", note("n1"));
      result.current.popOut("p1", note("n2"));
      result.current.popOut("p2", note("n1"));
    });
    expect(result.current.entries).toHaveLength(3);
    expect(result.current.entries.filter((entry) => entry.projectId === "p1").map((entry) => entry.note.id)).toEqual(["n1", "n2"]);
    act(() => result.current.close("p1", "n1"));
    expect(result.current.entries.map((entry) => `${entry.projectId}:${entry.note.id}`)).toEqual(["p1:n2", "p2:n1"]);
  });
});
