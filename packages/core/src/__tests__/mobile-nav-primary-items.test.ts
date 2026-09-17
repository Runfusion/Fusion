import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_NAV_PRIMARY_ITEMS,
  MAX_MOBILE_NAV_PRIMARY_ITEMS,
  MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS,
  MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS,
  MOBILE_NAV_SELECTABLE_ITEMS,
  resolveMobileNavPrimaryItems,
  resolveNavigationQuickAccessEntryIds,
} from "../board/mobile-nav-primary-items.js";

describe("resolveMobileNavPrimaryItems", () => {
  /*
   * FN-511 : la rangée d'accès rapide vaut CINQ destinations plus « More », et `chat` est la cinquième du défaut :
   * c'est ce qui lui donne la place tout à droite du pied de page large tant que l'opérateur n'a pas défini cinq
   * destinations explicites.
   */
  it("uses the five-destination quick-access default ending in chat for unset or empty values", () => {
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).toEqual(["command-center", "tasks", "planning", "missions", "chat"]);
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS.at(-1)).toBe("chat");
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).not.toContain("agents");
    expect(MAX_MOBILE_NAV_PRIMARY_ITEMS).toBe(5);
    expect(resolveMobileNavPrimaryItems()).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [] })).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems().omittedItems).toContain("mailbox");
    expect(resolveMobileNavPrimaryItems().omittedItems).not.toContain("chat");
  });

  /*
   * FN-511 : cas de MISE À JOUR. La valeur persistée par la version précédente compte quatre destinations sans `chat`.
   * Le complément déterministe ajoute `chat` en cinquième position, donc le Chat reste rendu tout à droite du pied de
   * page et n'est PAS dupliqué dans « Plus » — aucune migration de données n'est nécessaire.
   */
  it("completes a legacy four-destination selection with chat in the fifth slot", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["command-center", "tasks", "planning", "missions"],
    });
    expect(resolved.primaryItems).toEqual(["command-center", "tasks", "planning", "missions", "chat"]);
    expect(resolved.omittedItems).not.toContain("chat");
  });

  it("completes a customized legacy four-destination selection with chat", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["agents", "tasks", "git", "missions"] });
    expect(resolved.primaryItems).toEqual(["agents", "tasks", "git", "missions", "chat"]);
    expect(resolved.omittedItems).not.toContain("chat");
  });

  /*
   * FN-511 : le complément privilégie la FIN de l'ordre par défaut (terminé par `chat`), puis ajoute les destinations
   * retenues dans cet ordre. Une sélection très courte reste donc complétée jusqu'à exactement cinq, sans doublon, et
   * conserve le Chat en dernière position.
   */
  it("completes a short selection up to exactly five, without duplicates, keeping chat last", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["agents"] });
    expect(resolved.primaryItems).toEqual(["agents", "tasks", "planning", "missions", "chat"]);
    expect(resolved.primaryItems).toHaveLength(MAX_MOBILE_NAV_PRIMARY_ITEMS);
    expect(new Set(resolved.primaryItems).size).toBe(resolved.primaryItems.length);
    expect(resolved.omittedItems).not.toContain("chat");
  });

  /*
   * FN-511 : une sélection EXPLICITE de cinq destinations sans `chat` est laissée telle quelle. C'est le seul moyen de
   * retirer le Chat du pied de page ; il redevient alors une entrée du menu « Plus ».
   */
  it("leaves an explicit five-destination selection without chat untouched", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["command-center", "tasks", "missions", "mailbox", "planning"],
    });
    expect(resolved.primaryItems).toEqual(["command-center", "tasks", "missions", "mailbox", "planning"]);
    expect(resolved.omittedItems).toContain("chat");
  });

  it("truncates a six-destination selection to five without completing it", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["agents", "git", "files", "workflows", "mailbox", "missions"],
    });
    expect(resolved.primaryItems).toEqual(["agents", "git", "files", "workflows", "mailbox"]);
    expect(resolved.primaryItems).toHaveLength(MAX_MOBILE_NAV_PRIMARY_ITEMS);
    expect(resolved.omittedItems).toContain("missions");
  });

  it("preserves a persisted order that puts chat first", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["chat", "tasks", "planning", "missions", "mailbox"],
    });
    expect(resolved.primaryItems).toEqual(["chat", "tasks", "planning", "missions", "mailbox"]);
    expect(resolved.omittedItems).not.toContain("chat");
  });

  it("accepts eligible destinations, preserves persisted order, and routes omitted destinations to More", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["git", "planning", "agents"] });
    expect(resolved.primaryItems).toEqual(["git", "planning", "agents", "missions", "chat"]);
    expect(resolved.omittedItems).not.toContain("git");
    expect(resolved.omittedItems).toContain("settings");
  });

  /*
   * FN-446 : une destination sans entrée de pied de page ne peut pas être promue en accès rapide. Elle reste
   * enregistrée (libellés, feuille « More » mobile) mais ne revendique plus une rangée qui ne pourrait pas la rendre.
   * FN-511 retire `chat` de cette liste : il possède désormais une entrée de pied de page.
   */
  it.each(["ideation", "notes", "settings", "patchnode", "activity", "usage", "projects", "secrets"] as const)(
    "keeps the footer-ineligible destination %s out of the quick-access row",
    (item) => {
      expect(MOBILE_NAV_SELECTABLE_ITEMS).toContain(item);
      expect(MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS).not.toContain(item);
      const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [item] });
      expect(resolved.primaryItems).toEqual(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS);
      expect(resolved.omittedItems).toContain(item);
    },
  );

  it("chat is an ordinary eligible quick-access destination", () => {
    expect(MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS).toContain("chat");
    expect(MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS.chat).toBe("chat");
  });

  it("migrates retired category destinations to Mailbox, deduplicates, ignores unknowns, and clamps to five", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["tasks", "more", "documents", "recommendations", "tasks", "agents", "missions", "git", "files", "workflows", "unknown"],
    });
    expect(resolved.primaryItems).toEqual(["tasks", "mailbox", "agents", "missions", "git"]);
    expect(resolved.primaryItems).toHaveLength(MAX_MOBILE_NAV_PRIMARY_ITEMS);
    expect(resolved.omittedItems).not.toContain("mailbox");
    expect(MOBILE_NAV_SELECTABLE_ITEMS).not.toContain("documents");
    expect(MOBILE_NAV_SELECTABLE_ITEMS).not.toContain("recommendations");
  });

  it("never lists a resolved destination in omittedItems", () => {
    for (const selection of [undefined, [], ["chat"], ["agents", "tasks", "git", "missions"], ["command-center", "tasks", "missions", "mailbox", "planning"]]) {
      const resolved = resolveMobileNavPrimaryItems(selection ? { mobileNavPrimaryItems: selection } : undefined);
      for (const item of resolved.primaryItems) expect(resolved.omittedItems).not.toContain(item);
    }
  });
});

describe("resolveNavigationQuickAccessEntryIds", () => {
  /* FN-446 : `tasks` est l'identifiant persisté du Board, dont l'entrée de registre s'appelle `board`. */
  it("maps persisted destination ids to navigation registry entry ids", () => {
    expect(MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS.tasks).toBe("board");
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["mailbox", "agents", "tasks", "git", "files"] })).toEqual(["mailbox", "agents", "board", "git-manager", "files"]);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["git", "automation", "github-import", "workflows", "skills"] })).toEqual(["git-manager", "automations", "import-tasks", "workflows", "skills"]);
  });

  it("falls back to the default quick-access row for unset, empty, or fully ineligible selections", () => {
    const expected = ["command-center", "board", "planning", "missions", "chat"];
    expect(resolveNavigationQuickAccessEntryIds()).toEqual(expected);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: [] })).toEqual(expected);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["notes", "secrets"] })).toEqual(expected);
  });

  /* FN-511 : le complément conserve la position, donc `chat` est traduit en dernière entrée de la rangée. */
  it("translates the completed selection, keeping chat in the position produced by completion", () => {
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["command-center", "tasks", "planning", "missions"] }))
      .toEqual(["command-center", "board", "planning", "missions", "chat"]);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["chat", "tasks", "planning", "missions", "mailbox"] }))
      .toEqual(["chat", "board", "planning", "missions", "mailbox"]);
  });

  it("every selectable destination maps to a distinct registry entry id", () => {
    const entryIds = MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS.map((item) => MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS[item]);
    expect(entryIds.every((entryId) => typeof entryId === "string" && entryId.length > 0)).toBe(true);
    expect(new Set(entryIds).size).toBe(entryIds.length);
  });
});
