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
   * FN-495 : la rangée d'accès rapide vaut QUATRE destinations plus « More ». Le cinquième créneau appartient au
   * Chat, non configurable, donc `mailbox` quitte le défaut et rejoint « Plus ». Agents n'y figure toujours pas.
   */
  it("uses the four-destination quick-access default for unset or empty values", () => {
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).toEqual(["command-center", "tasks", "planning", "missions"]);
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).not.toContain("agents");
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).not.toContain("mailbox");
    expect(MAX_MOBILE_NAV_PRIMARY_ITEMS).toBe(4);
    expect(resolveMobileNavPrimaryItems()).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [] })).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems().omittedItems).toContain("mailbox");
  });

  /*
   * FN-495 : une sélection héritée de cinq identifiants éligibles perd sa cinquième entrée, qui redevient atteignable
   * depuis « Plus ». Aucune migration n'est nécessaire : la troncature du résolveur suffit.
   */
  it("truncates a legacy five-destination selection and routes its fifth entry to More", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["command-center", "tasks", "planning", "missions", "mailbox"],
    });
    expect(resolved.primaryItems).toEqual(["command-center", "tasks", "planning", "missions"]);
    expect(resolved.omittedItems).toContain("mailbox");
    expect(resolved.omittedItems).toContain("chat");
  });

  it("accepts eligible destinations, preserves persisted order, and routes omitted destinations to More", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["git", "planning", "agents"] });
    expect(resolved.primaryItems).toEqual(["git", "planning", "agents"]);
    expect(resolved.omittedItems).not.toContain("git");
    expect(resolved.omittedItems).toContain("settings");
    expect(resolved.omittedItems).toContain("chat");
  });

  /*
   * FN-446 : une destination sans entrée de pied de page ne peut plus être promue en accès rapide. Elle reste
   * enregistrée (libellés, feuille « More » mobile) mais ne revendique plus une rangée qui ne pourrait pas la rendre.
   */
  it.each(["ideation", "chat", "notes", "settings", "patchnode", "activity", "usage", "projects", "secrets"] as const)(
    "keeps the footer-ineligible destination %s out of the quick-access row",
    (item) => {
      expect(MOBILE_NAV_SELECTABLE_ITEMS).toContain(item);
      expect(MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS).not.toContain(item);
      const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [item] });
      expect(resolved.primaryItems).toEqual(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS);
      expect(resolved.omittedItems).toContain(item);
    },
  );

  it("migrates retired category destinations to Mailbox, deduplicates, ignores unknowns, and clamps to four", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["tasks", "more", "documents", "recommendations", "tasks", "agents", "missions", "git", "files", "workflows", "unknown"],
    });
    expect(resolved.primaryItems).toEqual(["tasks", "mailbox", "agents", "missions"]);
    expect(resolved.primaryItems).toHaveLength(MAX_MOBILE_NAV_PRIMARY_ITEMS);
    expect(resolved.omittedItems).not.toContain("mailbox");
    expect(MOBILE_NAV_SELECTABLE_ITEMS).not.toContain("documents");
    expect(MOBILE_NAV_SELECTABLE_ITEMS).not.toContain("recommendations");
  });
});

describe("resolveNavigationQuickAccessEntryIds", () => {
  /* FN-446 : `tasks` est l'identifiant persisté du Board, dont l'entrée de registre s'appelle `board`. */
  it("maps persisted destination ids to navigation registry entry ids", () => {
    expect(MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS.tasks).toBe("board");
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["mailbox", "agents", "tasks"] })).toEqual(["mailbox", "agents", "board"]);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["git", "automation", "github-import"] })).toEqual(["git-manager", "automations", "import-tasks"]);
  });

  it("falls back to the default quick-access row for unset, empty, or fully ineligible selections", () => {
    const expected = ["command-center", "board", "planning", "missions"];
    expect(resolveNavigationQuickAccessEntryIds()).toEqual(expected);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: [] })).toEqual(expected);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["chat", "notes"] })).toEqual(expected);
  });

  it("every selectable destination maps to a distinct registry entry id", () => {
    const entryIds = MOBILE_NAV_PRIMARY_SELECTABLE_ITEMS.map((item) => MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS[item]);
    expect(entryIds.every((entryId) => typeof entryId === "string" && entryId.length > 0)).toBe(true);
    expect(new Set(entryIds).size).toBe(entryIds.length);
  });
});
