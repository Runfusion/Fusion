import { describe, expect, it } from "vitest";
import { DEFAULT_MOBILE_NAV_PRIMARY_ITEMS, MOBILE_NAV_SELECTABLE_ITEMS, resolveMobileNavPrimaryItems } from "../board/mobile-nav-primary-items.js";

describe("resolveMobileNavPrimaryItems", () => {
  it("uses the existing six-tab order for unset or empty values", () => {
    expect(resolveMobileNavPrimaryItems()).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [] })).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
  });

  it("accepts newly eligible destinations, preserves order, and routes omitted destinations to More", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["git", "notes", "planning", "agents"] });
    expect(resolved.primaryItems).toEqual(["git", "notes", "planning", "agents"]);
    expect(resolved.omittedItems).not.toContain("git");
    expect(resolved.omittedItems).toContain("settings");
  });

  it("keeps Ideation in More when stale settings try to promote it", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["ideation"] });

    expect(MOBILE_NAV_SELECTABLE_ITEMS).toContain("ideation");
    expect(resolved.primaryItems).not.toContain("ideation");
    expect(resolved.omittedItems).toContain("ideation");
  });

  it("migrates retired category destinations to Mailbox, deduplicates, and clamps footer tabs", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["settings", "tasks", "more", "documents", "recommendations", "tasks", "agents", "missions", "chat", "unknown"],
    });
    expect(resolved.primaryItems).toEqual(["settings", "tasks", "mailbox", "agents", "missions", "chat"]);
    expect(resolved.omittedItems).not.toContain("settings");
    expect(resolved.omittedItems).not.toContain("mailbox");
    expect(MOBILE_NAV_SELECTABLE_ITEMS).not.toContain("documents");
    expect(MOBILE_NAV_SELECTABLE_ITEMS).not.toContain("recommendations");
  });
});
