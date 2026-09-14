import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIEW_SIDEBAR_DEFAULT_WIDTH,
  VIEW_SIDEBAR_MAX_WIDTH,
  VIEW_SIDEBAR_MIN_WIDTH,
  VIEW_SIDEBAR_STORAGE_KEY,
  ViewLayoutProvider,
  clampViewSidebarWidth,
  parseViewSidebarWidth,
} from "../ViewLayoutContext";
import { useViewSidebarWidth } from "../../hooks/useViewSidebarWidth";
import { scopedKey } from "../../utils/projectStorage";

function WidthConsumer({ name }: { name: string }) {
  const width = useViewSidebarWidth();
  return (
    <section>
      <output aria-label={name}>{width.width}</output>
      <button type="button" onClick={() => width.previewWidth(420)}>Aperçu {name}</button>
      <button type="button" onClick={() => width.commitWidth(430)}>Enregistrer {name}</button>
    </section>
  );
}

function Harness({ projectId }: { projectId?: string }) {
  return (
    <ViewLayoutProvider projectId={projectId}>
      <WidthConsumer name="premier" />
      <WidthConsumer name="second" />
    </ViewLayoutProvider>
  );
}

describe("ViewLayoutContext", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [null, VIEW_SIDEBAR_DEFAULT_WIDTH],
    ["", VIEW_SIDEBAR_DEFAULT_WIDTH],
    ["   ", VIEW_SIDEBAR_DEFAULT_WIDTH],
    ["NaN", VIEW_SIDEBAR_DEFAULT_WIDTH],
    ["Infinity", VIEW_SIDEBAR_DEFAULT_WIDTH],
    ["100", VIEW_SIDEBAR_MIN_WIDTH],
    ["999", VIEW_SIDEBAR_MAX_WIDTH],
    ["319.6", 320],
  ])("normalise la valeur persistée %s", (raw, expected) => {
    expect(parseViewSidebarWidth(raw)).toBe(expected);
  });

  it("synchronise deux consommateurs et persiste uniquement au commit", async () => {
    render(<Harness projectId="project-a" />);
    await userEvent.click(screen.getByRole("button", { name: "Aperçu premier" }));
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual(["420", "420"]);
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Enregistrer second" }));
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual(["430", "430"]);
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"))).toBe("430");
  });

  it("isole A et B et restaure chaque préférence au retour", async () => {
    localStorage.setItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"), "410");
    localStorage.setItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-b"), "250");
    const { rerender } = render(<Harness projectId="project-a" />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("410");
    rerender(<Harness projectId="project-b" />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("250");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer premier" }));
    expect(localStorage.getItem(scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-b"))).toBe("430");
    rerender(<Harness projectId="project-a" />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("410");
  });

  it("ignore les anciennes clés divergentes et refuse toute persistance sans projet", async () => {
    localStorage.setItem("fusion:planning-sidebar-width", "555");
    localStorage.setItem("fusion:file-browser-sidebar-width", "222");
    localStorage.setItem("kb-dashboard-agents-sidebar-width", "333");
    render(<Harness />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(String(VIEW_SIDEBAR_DEFAULT_WIDTH));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer premier" }));
    expect(localStorage.getItem(VIEW_SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("applique un événement storage du projet courant sans le réécrire", () => {
    const setItem = vi.spyOn(localStorage, "setItem");
    render(<Harness projectId="project-a" />);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-other"),
      newValue: "500",
    })));
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("300");
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: scopedKey(VIEW_SIDEBAR_STORAGE_KEY, "project-a"),
      newValue: "500",
    })));
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("500");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("reste opérant lorsque le getter ou l’écriture storage refuse l’accès", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
    try {
      render(<Harness projectId="project-a" />);
      expect(screen.getAllByRole("status")[0]).toHaveTextContent("300");
      await userEvent.click(screen.getByRole("button", { name: "Enregistrer premier" }));
      expect(screen.getAllByRole("status")[0]).toHaveTextContent("430");
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    }

    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    render(<Harness projectId="project-c" />);
    await userEvent.click(screen.getAllByRole("button", { name: "Enregistrer premier" }).at(-1)!);
    expect(screen.getAllByRole("status").at(-2)).toHaveTextContent("430");
    expect(write).toHaveBeenCalled();
  });

  it("borne toute entrée publique", () => {
    expect(clampViewSidebarWidth(Number.NaN)).toBe(VIEW_SIDEBAR_DEFAULT_WIDTH);
    expect(clampViewSidebarWidth(-1)).toBe(VIEW_SIDEBAR_MIN_WIDTH);
    expect(clampViewSidebarWidth(10_000)).toBe(VIEW_SIDEBAR_MAX_WIDTH);
  });
});
