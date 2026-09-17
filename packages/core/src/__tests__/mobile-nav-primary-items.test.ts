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
   * FN-446 : la rangée d'accès rapide vaut cinq destinations plus « More », et Agents n'y figure plus par défaut.
   */
  it("uses the five-destination quick-access default for unset or empty values", () => {
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).toEqual(["command-center", "tasks", "planning", "missions", "mailbox"]);
    expect(DEFAULT_MOBILE_NAV_PRIMARY_ITEMS).not.toContain("agents");
    expect(MAX_MOBILE_NAV_PRIMARY_ITEMS).toBe(5);
    expect(resolveMobileNavPrimaryItems()).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [] })).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
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
});

describe("resolveNavigationQuickAccessEntryIds", () => {
  /* FN-446 : `tasks` est l'identifiant persisté du Board, dont l'entrée de registre s'appelle `board`. */
  it("maps persisted destination ids to navigation registry entry ids", () => {
    expect(MOBILE_NAV_PRIMARY_ITEM_NAVIGATION_ENTRY_IDS.tasks).toBe("board");
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["mailbox", "agents", "tasks"] })).toEqual(["mailbox", "agents", "board"]);
    expect(resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["git", "automation", "github-import"] })).toEqual(["git-manager", "automations", "import-tasks"]);
  });

  it("falls back to the default quick-access row for unset, empty, or fully ineligible selections", () => {
    const expected = ["command-center", "board", "planning", "missions", "mailbox"];
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
