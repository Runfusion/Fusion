// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isInsidePortaledModelMenu, isInsidePortalSafeSurface } from "../portalSurfaces";

describe("portal surfaces", () => {
  it("recognizes model menus including text-node event targets", () => {
    const menu = document.createElement("div");
    menu.className = "model-combobox-dropdown--portal";
    const text = document.createTextNode("Filter models");
    menu.append(text);
    document.body.append(menu);
    expect(isInsidePortaledModelMenu(menu)).toBe(true);
    expect(isInsidePortaledModelMenu(text)).toBe(true);
  });

  it("separates generic safe surfaces from model-menu surfaces", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const child = document.createElement("button");
    dialog.append(child);
    document.body.append(dialog);
    expect(isInsidePortalSafeSurface(child)).toBe(true);
    expect(isInsidePortaledModelMenu(child)).toBe(false);
  });

  it("rejects outside, null, and non-node targets", () => {
    expect(isInsidePortalSafeSurface(document.createElement("div"))).toBe(false);
    expect(isInsidePortaledModelMenu(null)).toBe(false);
    expect(isInsidePortalSafeSurface({})).toBe(false);
  });
});
