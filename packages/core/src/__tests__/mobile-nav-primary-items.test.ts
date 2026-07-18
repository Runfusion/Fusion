import { describe, expect, it } from "vitest";
import { DEFAULT_MOBILE_NAV_PRIMARY_ITEMS, resolveMobileNavPrimaryItems } from "../mobile-nav-primary-items.js";

describe("resolveMobileNavPrimaryItems", () => {
  it("uses the existing six-tab order for unset or empty values", () => {
    expect(resolveMobileNavPrimaryItems()).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [] })).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
  });

  it("accepts newly eligible destinations, preserves order, and routes omitted destinations to More", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["git", "planning", "agents"] });
    expect(resolved.primaryItems).toEqual(["git", "planning", "agents"]);
    expect(resolved.omittedItems).not.toContain("git");
    expect(resolved.omittedItems).toContain("settings");
  });

  it("keeps newly eligible settings and documents, drops overflow-only ids, deduplicates, and clamps footer tabs", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["settings", "tasks", "more", "documents", "tasks", "agents", "missions", "chat", "mailbox", "planning", "unknown"],
    });
    expect(resolved.primaryItems).toEqual(["settings", "tasks", "documents", "agents", "missions", "chat"]);
    expect(resolved.omittedItems).not.toContain("settings");
    expect(resolved.omittedItems).not.toContain("documents");
    expect(resolved.omittedItems).toContain("git");
  });
});
