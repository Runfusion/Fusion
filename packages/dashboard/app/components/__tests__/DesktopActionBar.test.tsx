import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopActionBar } from "../DesktopActionBar";
import { useExecutorStats } from "../../hooks/useExecutorStats";
import { buildDashboardNavigationEntries, type DashboardNavigationRegistryOptions } from "../dashboardNavigationEntries";
import { readAppFile } from "../../test/cssFixture";

const alphaDesktopActionBarCss = readAppFile("components/DesktopActionBar.css");
const headerCss = readAppFile("components/Header.css");
const leftSidebarNavCss = readAppFile("components/LeftSidebarNav.css");
const mobileNavBarCss = readAppFile("components/MobileNavBar.css");
const windowVisibilityToggleCss = readAppFile("components/DashboardWindowVisibilityToggle.css");
const overflowMenuRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar__menu\s*\{([^}]*)\}/s)?.[1] ?? "";
const overflowCorridorRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar__more::before\s*\{([^}]*)\}/s)?.[1] ?? "";

/*
 * FN-467 : le centrage réel du groupe « rangée directe + More » n'est pas mesurable dans jsdom (aucune mise en page).
 * La preuve exécutable porte donc sur le CONTRAT de pistes déclaré par la feuille de style : on découpe la valeur en
 * pistes de premier niveau (parenthèses respectées) puis on compare la première et la dernière par égalité de chaînes.
 */
function ruleOf(css: string, selector: string): string {
  return css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function declarationOf(rule: string, property: string): string {
  return rule.match(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? "";
}

function splitTopLevelTracks(value: string): string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && /\s/.test(char)) {
      if (current.trim()) tracks.push(current.trim().replace(/\s+/g, " "));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) tracks.push(current.trim().replace(/\s+/g, " "));
  return tracks;
}

vi.mock("../../hooks/useExecutorStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useExecutorStats")>();
  return { ...actual, useExecutorStats: vi.fn() };
});

function entries(onChangeView = vi.fn(), overrides: Partial<DashboardNavigationRegistryOptions> = {}) {
  return buildDashboardNavigationEntries({ view: "board", onChangeView, onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, ...overrides });
}

/* FN-469 : Settings est routé par `onOpenSettings`, pas par `onChangeView`; les deux affordances partagent ce même propriétaire. */
function entriesWithSettingsOwner(onOpenSettings: () => void) {
  return entries(vi.fn(), { onOpenSettings });
}

function openOverflowMenu() {
  fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
  return screen.getByRole("menu");
}

function expectAscendingSingleColumnGeometry(menu: HTMLElement) {
  expect(menu).toHaveClass("desktop-action-bar__menu");
  expect(overflowMenuRule).toMatch(/inset-inline-start:\s*50%/);
  expect(overflowMenuRule).toMatch(/transform:\s*translateX\(-50%\)/);
  expect(overflowMenuRule).not.toMatch(/inset-inline-end:\s*0/);
  expect(overflowMenuRule).toMatch(/bottom:\s*calc\(100% \+ var\(--space-sm\)\)/);
  expect(overflowCorridorRule).toMatch(/inset-inline:\s*0/);
  expect(overflowCorridorRule).toMatch(/bottom:\s*100%/);
  expect(overflowCorridorRule).toMatch(/block-size:\s*var\(--space-sm\)/);
  expect(overflowMenuRule).toMatch(/grid-template-columns:\s*1fr/);
  expect(overflowMenuRule).toMatch(/grid-auto-flow:\s*row/);
  expect(overflowMenuRule).toMatch(/max-block-size:\s*calc\(100vh - var\(--space-3xl\) \* 3\)/);
  expect(overflowMenuRule).toMatch(/overflow-y:\s*auto/);
  expect(overflowMenuRule).not.toContain("repeat(3");
}

describe("DesktopActionBar", () => {
  beforeEach(() => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 0, maxConcurrent: 4 } as never, loading: false, error: null, refresh: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /*
   * FN-467 cas (a) — reproduction automatisée du symptôme : sur la base, `.desktop-action-bar` était un conteneur flex
   * sans AUCUNE piste latérale, donc l'extraction ci-dessous ne produisait rien et l'égalité des deux pistes échouait.
   */
  it("déclare deux pistes latérales strictement identiques autour du groupe centré", () => {
    const barRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar");
    expect(barRule).toBeTruthy();
    expect(declarationOf(barRule, "display")).toBe("grid");

    const tracks = splitTopLevelTracks(declarationOf(barRule, "grid-template-columns"));
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toBe(tracks[2]);
    expect(tracks[1]).toMatch(/^(auto|max-content|min-content|fit-content\(.*\))$/);
    expect(tracks[0]).not.toMatch(/\d+px/);

    const centerRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__center");
    expect(declarationOf(centerRule, "grid-column")).toBe("2");

    const rightRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__right");
    expect(rightRule).not.toMatch(/margin-inline-start:\s*auto/);
    expect(declarationOf(rightRule, "grid-column")).toBe("3");
    expect(declarationOf(rightRule, "margin-inline-end")).toBe("var(--touch-target-min-size)");

    const placeholderRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar > .dashboard-window-visibility-toggle__placeholder");
    expect(placeholderRule).toBeTruthy();
    expect(declarationOf(placeholderRule, "grid-column")).toBe("3");
    expect(declarationOf(placeholderRule, "grid-row")).toBe("1");
    expect(declarationOf(placeholderRule, "inline-size")).toBe("var(--touch-target-min-size)");
    expect(placeholderRule).not.toMatch(/\d+px/);
  });

  /*
   * FN-484 : le contrôle de visibilité des fenêtres doit avoir EXACTEMENT la peinture du bouton Settings icône seule.
   * Il est portalisé hors de la barre, donc la parité ne peut pas venir de l'héritage : elle se prouve déclaration par
   * déclaration entre sa propre feuille et celle du bouton de référence.
   */
  it("peint le contrôle de visibilité des fenêtres comme le bouton Settings icône seule", () => {
    const actionRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__action");
    const iconOnlyRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__action--icon-only");
    const actionIconRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__icon > svg");
    const actionHoverRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__action:hover, .desktop-action-bar__action--active");
    const actionFocusRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__action:focus-visible");
    expect(actionRule && iconOnlyRule && actionIconRule && actionHoverRule && actionFocusRule).toBeTruthy();

    const toggleRule = ruleOf(windowVisibilityToggleCss, ".dashboard-window-visibility-toggle__button");
    expect(toggleRule).toBeTruthy();
    for (const property of ["border", "border-radius", "color", "background", "font", "cursor", "align-items", "justify-content"]) {
      expect(declarationOf(toggleRule, property)).toBe(declarationOf(actionRule, property));
    }
    expect(declarationOf(toggleRule, "padding-inline")).toBe(declarationOf(iconOnlyRule, "padding-inline"));
    expect(declarationOf(toggleRule, "border-radius")).not.toBe("0");
    expect(toggleRule).not.toMatch(/border-radius:\s*0/);

    const toggleHoverRule = ruleOf(
      windowVisibilityToggleCss,
      ".dashboard-window-visibility-toggle__button:hover:not(:disabled),\n.dashboard-window-visibility-toggle__button[aria-pressed=\"true\"]:not(:disabled)",
    );
    expect(declarationOf(toggleHoverRule, "color")).toBe(declarationOf(actionHoverRule, "color"));
    expect(declarationOf(toggleHoverRule, "background")).toBe(declarationOf(actionHoverRule, "background"));

    const toggleFocusRule = ruleOf(windowVisibilityToggleCss, ".dashboard-window-visibility-toggle__button:focus-visible");
    expect(declarationOf(toggleFocusRule, "box-shadow")).toBe(declarationOf(actionFocusRule, "box-shadow"));
    expect(declarationOf(toggleFocusRule, "outline")).toBe(declarationOf(actionFocusRule, "outline"));

    const toggleIconRule = ruleOf(windowVisibilityToggleCss, ".dashboard-window-visibility-toggle__button svg");
    expect(declarationOf(toggleIconRule, "inline-size")).toBe(declarationOf(actionIconRule, "inline-size"));
    expect(declarationOf(toggleIconRule, "block-size")).toBe(declarationOf(actionIconRule, "block-size"));

    /* Le trait séparateur qui détachait le contrôle du reste de la barre disparaît, sans coquille bordée résiduelle. */
    const sharedPlaceholderRule = ruleOf(windowVisibilityToggleCss, ".dashboard-window-visibility-toggle__placeholder");
    expect(sharedPlaceholderRule).toBeTruthy();
    expect(sharedPlaceholderRule).not.toMatch(/border/);
    expect(windowVisibilityToggleCss.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/border-inline-start/);
    /* La règle de masquage ≤768 px reste intacte. */
    expect(windowVisibilityToggleCss).toMatch(/@media \(max-width: 768px\)/);
  });

  /*
   * FN-484 : « dans l'angle avec exactement le même espace en bas qu'à sa droite ». L'espace à droite est le
   * `padding-inline` de la barre ; l'espace en bas ne peut exister dans une barre de hauteur fixe que si le placeholder
   * est centré et raccourci du MÊME token de chaque côté.
   */
  it("insère le contrôle dans l'angle avec un espace bas égal à son espace droit", () => {
    const barRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar");
    const inlineGutter = declarationOf(barRule, "padding-inline");
    expect(inlineGutter).toBe("var(--space-sm)");

    const placeholderRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar > .dashboard-window-visibility-toggle__placeholder");
    expect(declarationOf(placeholderRule, "align-self")).toBe("center");
    expect(declarationOf(placeholderRule, "inline-size")).toBe("var(--touch-target-min-size)");

    const blockSize = declarationOf(placeholderRule, "block-size");
    expect(blockSize).toBe(`calc(var(--executor-footer-height) - ${inlineGutter} * 2)`);
    expect(declarationOf(barRule, "block-size")).toBe("var(--executor-footer-height)");
    expect(placeholderRule).not.toMatch(/\d+px/);
  });

  /* FN-467 cas (b) : les cinq accès rapides ET le déclencheur More appartiennent au même groupe centré, dans l'ordre persisté. */
  it("regroupe les accès rapides et More dans l'unique groupe centré", () => {
    render(<DesktopActionBar entries={entries(vi.fn(), { quickAccessEntryIds: ["mailbox", "missions", "board", "planning", "command-center"] })} activeId="board" tasks={[]} onToggleTerminal={vi.fn()} />);
    const centers = document.querySelectorAll(".desktop-action-bar__center");
    expect(centers).toHaveLength(1);
    const center = centers[0] as HTMLElement;

    expect(Array.from(center.querySelectorAll<HTMLElement>(".desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
      "desktop-nav-mailbox",
      "desktop-nav-missions",
      "desktop-nav-board",
      "desktop-nav-planning",
      "desktop-nav-command-center",
      "desktop-nav-more",
    ]);
    expect(center).not.toContainElement(screen.getByTestId("desktop-capacity-count"));
    expect(center).not.toContainElement(screen.getByTestId("desktop-nav-settings-icon"));
    expect(center).not.toContainElement(screen.getByTestId("desktop-nav-terminal"));

    const menu = openOverflowMenu();
    for (const testId of ["desktop-nav-mailbox", "desktop-nav-missions", "desktop-nav-board", "desktop-nav-planning", "desktop-nav-command-center"]) {
      expect(within(menu).queryByTestId(testId)).toBeNull();
    }
  });

  /* FN-467 cas (c) : contrôle de breakpoint — le footer partagé tablette/ordinateur est le seul rendu, la pill mobile est masquée. */
  it("reste le seul propriétaire de navigation basse sur tablette et ordinateur", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    expect(screen.getByTestId("desktop-action-bar")).toBeInTheDocument();
    expect(document.querySelector(".mobile-nav-bar")).toBeNull();
    expect(mobileNavBarCss).toMatch(/html:is\(\[data-viewport-mode="tablet"\], \[data-viewport-mode="desktop"\]\) \.mobile-nav-bar\s*\{\s*display:\s*none/);
    /*
     * FN-469 cas (x) : tablette et ordinateur partagent CE footer, donc les deux affordances Settings y sont rendues
     * à l'identique — une seule composition, pas une variante par breakpoint.
     */
    expect(screen.getByTestId("desktop-nav-settings-icon")).toBeInTheDocument();
    expect(within(openOverflowMenu()).getByTestId("desktop-nav-settings")).toBeInTheDocument();
  });

  it("affiche le footer principal sans les destinations du dock ou de Done", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const footer = screen.getByTestId("desktop-action-bar");
    expect(footer).toBeInTheDocument();
    expect(footer.lastElementChild).toHaveClass("dashboard-window-visibility-toggle__placeholder");
    expect(screen.getByTestId("desktop-nav-board")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("desktop-nav-new-task")).toBeNull();
    expect(screen.getByTestId("desktop-capacity-count")).toHaveTextContent("0 / 4");
    /*
     * FN-469 : Settings quitte le coin inférieur droit. Il est désormais une action en icône seule voisine du compteur
     * de concurrence (piste de début) et la dernière entrée du menu More ; le groupe de droite ne le contient plus.
     */
    expect(screen.getByTestId("desktop-nav-settings-icon")).toHaveAccessibleName("Settings");
    expect(document.querySelector(".desktop-action-bar__leading")).toContainElement(screen.getByTestId("desktop-nav-settings-icon"));
    expect(screen.queryByTestId("desktop-nav-terminal")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__right")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-patchnode")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-chat")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-notes")).toBeNull();
  });

  /*
   * FN-469 cas (v) : le groupe de droite ne conserve que Chat et Terminal, et une entrée `settings` DUPLIQUéE ne
   * produit qu'un seul bouton icône et qu'une seule entrée More.
   */
  it("garde Terminal comme dernière action droite et dédoublonne Settings", () => {
    const onToggleTerminal = vi.fn();
    const populatedEntries = entries();
    const settings = populatedEntries.find((entry) => entry.id === "settings")!;
    render(<DesktopActionBar entries={[...populatedEntries, settings]} activeId="board" tasks={[]} onToggleTerminal={onToggleTerminal} />);

    const terminal = screen.getByTestId("desktop-nav-terminal");
    expect(screen.getAllByTestId("desktop-nav-terminal")).toHaveLength(1);
    expect(screen.getAllByTestId("desktop-nav-settings-icon")).toHaveLength(1);
    expect(terminal).toHaveAccessibleName("Terminal");
    expect(terminal.nextElementSibling).toBeNull();
    expect(document.querySelector(".desktop-action-bar__right")).not.toContainElement(screen.getByTestId("desktop-nav-settings-icon"));
    expect(within(openOverflowMenu()).getAllByTestId("desktop-nav-settings")).toHaveLength(1);
    fireEvent.click(terminal);
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
  });

  /* FN-469 cas (w) : sans entrée `settings`, aucun bouton icône, aucune entrée More, et aucune coquille à droite. */
  it("omet Terminal, Settings et le shell droit quand leurs propriétaires sont absents", () => {
    render(<DesktopActionBar entries={entries().filter((entry) => entry.id !== "settings")} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-terminal")).toBeNull();
    expect(screen.queryByTestId("desktop-nav-settings-icon")).toBeNull();
    expect(screen.queryByLabelText("Settings")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__right")).toBeNull();
    expect(within(openOverflowMenu()).queryByTestId("desktop-nav-settings")).toBeNull();
  });

  /* FN-489 (ex-FN-469 cas (s)+(t)) : le bouton icône est tout à gauche dans le coin, le compteur le suit immédiatement,
     le bouton n'a aucun texte visible et ouvre toujours les réglages. */
  it("rend le bouton Settings en icône seule tout à gauche, suivi du compteur de concurrence", () => {
    const onOpenSettings = vi.fn();
    render(<DesktopActionBar entries={entriesWithSettingsOwner(onOpenSettings)} activeId="board" tasks={[]} />);

    const leading = document.querySelector(".desktop-action-bar__leading")!;
    const capacity = document.querySelector(".desktop-action-bar__capacity")!;
    const icon = screen.getByTestId("desktop-nav-settings-icon");
    expect(leading.firstElementChild).toBe(icon);
    expect(icon.nextElementSibling).toBe(capacity);
    expect(icon).toHaveClass("desktop-action-bar__action");
    expect(icon.textContent).toBe("");
    expect(icon).toHaveAccessibleName("Settings");
    expect(icon.querySelector(".desktop-action-bar__icon")).not.toBeNull();
    expect(alphaDesktopActionBarCss).toMatch(/\.desktop-action-bar__action--icon-only\s*\{[^}]*min-inline-size:\s*var\(--touch-target-min-size\)/s);

    fireEvent.click(icon);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  /* FN-489 : sans entrée `settings`, la piste de début contient exactement un enfant (le compteur), sans coquille vide. */
  it("ne laisse aucune coquille dans la piste de début quand l'entrée Settings est absente", () => {
    render(<DesktopActionBar entries={entries().filter((entry) => entry.id !== "settings")} activeId="board" tasks={[]} projectId="proj_1" />);

    const leading = document.querySelector(".desktop-action-bar__leading")!;
    expect(screen.queryByTestId("desktop-nav-settings-icon")).toBeNull();
    expect(leading.children).toHaveLength(1);
    expect(leading.firstElementChild).toBe(document.querySelector(".desktop-action-bar__capacity"));
  });

  /* FN-489 : sans `projectId`, l'ordre et la composition de la piste restent identiques (aucun changement de comportement). */
  it("conserve l'ordre Settings puis compteur même sans projectId", () => {
    render(<DesktopActionBar entries={entriesWithSettingsOwner(vi.fn())} activeId="board" tasks={[]} />);

    const leading = document.querySelector(".desktop-action-bar__leading")!;
    expect(leading.children).toHaveLength(2);
    expect(leading.firstElementChild).toBe(screen.getByTestId("desktop-nav-settings-icon"));
    expect(leading.lastElementChild).toBe(document.querySelector(".desktop-action-bar__capacity"));
  });

  /*
  FN-489 : le déclencheur du compteur réutilise LITTÉRALEMENT `.desktop-action-bar__action`, donc son repos, son survol
  et son focus sont ceux des autres boutons de la barre; il ne porte plus la peinture générique `.btn` et garde son
  marqueur `engine-control-menu__trigger--text` (ciblé par LeftSidebarNav.css pour l'autre hôte).
  */
  it.each([
    ["peuplé", { runningTaskCount: 1, maxConcurrent: 3 }, false, null],
    ["chargement", { runningTaskCount: 0, maxConcurrent: 0 }, true, null],
    ["erreur", { runningTaskCount: 0, maxConcurrent: 0 }, false, "boom"],
  ] as const)("peint le compteur comme les autres actions du footer (état %s)", (_label, stats, loading, error) => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: stats as never, loading, error, refresh: vi.fn() });
    render(<DesktopActionBar entries={entriesWithSettingsOwner(vi.fn())} activeId="board" tasks={[]} projectId="proj_1" />);

    const trigger = screen.getByTestId("engine-control-menu-trigger");
    expect(trigger).toHaveClass("desktop-action-bar__action");
    expect(trigger).toHaveClass("engine-control-menu__trigger--text");
    expect(trigger).not.toHaveClass("btn");
    fireEvent.click(trigger);
    expect(screen.getByTestId("engine-control-menu")).not.toBeNull();
  });

  /* FN-489 : contrat CSS — aucune peinture concurrente locale, aucune règle :hover locale, ancrage du popover intact. */
  it("ne déclare aucune peinture locale concurrente pour le déclencheur du compteur", () => {
    const capacityTriggerRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__capacity .engine-control-menu__trigger--text");
    expect(declarationOf(capacityTriggerRule, "block-size")).toBe("100%");
    for (const property of ["background", "border", "color", "min-inline-size"]) {
      expect(declarationOf(capacityTriggerRule, property)).toBe("");
    }
    expect(alphaDesktopActionBarCss).not.toMatch(/\.desktop-action-bar__capacity[^{]*:hover/);

    const popoverRule = ruleOf(alphaDesktopActionBarCss, ".desktop-action-bar__capacity .engine-control-menu > .engine-control-menu__popover.card");
    expect(declarationOf(popoverRule, "inset-inline-start")).toBe("0");
    expect(declarationOf(popoverRule, "inset-inline-end")).toBe("auto");
    expect(declarationOf(popoverRule, "min-inline-size")).toBe("min(24rem, calc(100vw - (var(--space-lg) * 2)))");
    expect(declarationOf(popoverRule, "max-inline-size")).toBe("calc(100vw - (var(--space-lg) * 2))");
    expect(alphaDesktopActionBarCss).not.toMatch(/@media/);
  });

  /* FN-469 cas (u) : Settings est la DERNIÈRE entrée de More, et la sélectionner referme le menu. */
  it("place Settings en dernière position du menu More et referme après sélection", async () => {
    const onOpenSettings = vi.fn();
    render(<DesktopActionBar entries={entriesWithSettingsOwner(onOpenSettings)} activeId="board" tasks={[]} />);

    const menu = openOverflowMenu();
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .desktop-action-bar__action"));
    expect(items.at(-1)?.dataset.testid).toBe("desktop-nav-settings");

    fireEvent.click(within(menu).getByTestId("desktop-nav-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  /* FN-469 cas (u, bis) : sans aucune destination overflow, le périmètre More existe pour héberger Settings seul. */
  it("rend le périmètre More pour le seul Settings quand aucune destination overflow ne reste", () => {
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow");
    render(<DesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .desktop-action-bar__action")).map((item) => item.dataset.testid)).toEqual(["desktop-nav-settings"]);
  });

  it("conserve les actions droites hors du scroller avec une géométrie tokenisée", () => {
    const longEntries = entries(vi.fn(), {
      pluginDashboardViews: Array.from({ length: 30 }, (_, index) => ({
        pluginId: `plugin-${index}`,
        view: { viewId: "tool", label: `Plugin ${index}`, order: index },
      })),
    });
    render(<DesktopActionBar entries={longEntries} activeId="board" tasks={[]} onToggleTerminal={vi.fn()} />);
    const right = document.querySelector(".desktop-action-bar__right");
    expect(right).toContainElement(screen.getByTestId("desktop-nav-terminal"));
    expect(right).not.toContainElement(screen.getByTestId("desktop-nav-settings-icon"));
    expect(document.querySelector(".desktop-action-bar__scroller")).not.toContainElement(screen.getByTestId("desktop-nav-terminal"));
    expect(alphaDesktopActionBarCss).toMatch(/\.desktop-action-bar__right\s*\{[^}]*gap:\s*var\(--space-xs\)/s);
  });

  it("affiche honnêtement une capacité entièrement utilisée et ouvre ses réglages dans le viewport", () => {
    vi.mocked(useExecutorStats).mockReturnValue({ stats: { runningTaskCount: 3, maxConcurrent: 3 } as never, loading: false, error: null, refresh: vi.fn() });
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    expect(screen.getByTestId("desktop-capacity-count")).toHaveTextContent("3 / 3");
    fireEvent.click(screen.getByTestId("engine-control-menu-trigger"));
    expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    expect(alphaDesktopActionBarCss).toMatch(/\.desktop-action-bar__capacity \.engine-control-menu > \.engine-control-menu__popover\.card\s*\{[^}]*inset-inline-start:\s*0;[^}]*inset-inline-end:\s*auto;[^}]*min-inline-size:\s*min\(24rem,\s*calc\(100vw - \(var\(--space-lg\) \* 2\)\)\);[^}]*max-inline-size:\s*calc\(100vw - \(var\(--space-lg\) \* 2\)\);/s);
  });

  /*
   * FN-446 : Agents quitte la rangée directe du pied de page (défaut d'accès rapide à cinq destinations) et devient une
   * entrée ordinaire du menu **More**, sans coquille de bouton ni `aria-label` orphelin laissé derrière lui.
   */
  it("place Agents dans le menu More et non dans le rail direct par défaut", async () => {
    const onChangeView = vi.fn().mockResolvedValue(true);
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    const scroller = document.querySelector(".desktop-action-bar__scroller")!;
    expect(Array.from(scroller.querySelectorAll<HTMLElement>(".desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
      "desktop-nav-command-center",
      "desktop-nav-board",
      "desktop-nav-planning",
      "desktop-nav-missions",
      "desktop-nav-mailbox",
    ]);
    expect(screen.queryByTestId("desktop-nav-agents")).toBeNull();
    expect(screen.queryByLabelText("Agents")).toBeNull();

    const menu = openOverflowMenu();
    const agentsEntry = within(menu).getByTestId("desktop-nav-agents");
    expect(agentsEntry).toHaveAccessibleName("Agents");
    fireEvent.click(agentsEntry);
    expect(onChangeView).toHaveBeenCalledWith("agents");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  /* FN-446 : une sélection personnalisée définit l'ordre exact des accès rapides rendus. */
  it("rend la rangée directe dans l'ordre de la sélection d'accès rapide", () => {
    render(<DesktopActionBar entries={entries(vi.fn(), { quickAccessEntryIds: ["mailbox", "agents", "board"] })} activeId="board" tasks={[]} />);
    const scroller = document.querySelector(".desktop-action-bar__scroller")!;
    expect(Array.from(scroller.querySelectorAll<HTMLElement>(".desktop-action-bar__action")).map((button) => button.dataset.testid)).toEqual([
      "desktop-nav-mailbox",
      "desktop-nav-agents",
      "desktop-nav-board",
    ]);
    expect(within(openOverflowMenu()).getByTestId("desktop-nav-command-center")).toBeInTheDocument();
  });

  /* FN-446 : une sélection entièrement gatée off ne doit laisser aucune rangée directe vide dans le pied de page. */
  it("ne rend aucune rangée directe vide quand la sélection ne résout aucune destination", () => {
    render(<DesktopActionBar entries={entries(vi.fn(), { showAgents: false, quickAccessEntryIds: ["agents"] })} activeId="board" tasks={[]} />);
    expect(document.querySelector(".desktop-action-bar__scroller")).toBeNull();
    expect(screen.getByTestId("desktop-nav-more")).toBeInTheDocument();
    expect(within(openOverflowMenu()).getByTestId("desktop-nav-board")).toBeInTheDocument();
  });

  /*
   * FN-469 : le périmètre More héberge désormais Settings, donc l'absence de coquille se prouve sans AUCUNE entrée
   * à héberger — ni overflow, ni Settings.
   */
  it("ne rend aucun trigger, panneau ou shell vide sans destination overflow", () => {
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow" && entry.id !== "settings");
    render(<DesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-more")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector(".desktop-action-bar__more")).toBeNull();
  });

  /*
   * FN-439 cas (g) : le Header ne produit plus de bouton List sur tablette/ordinateur, donc le menu **More** du pied de
   * page en devient le propriétaire. La destination reste hors du rail direct, ferme le menu au clic et route vers
   * `list`.
   */
  it("expose List dans le menu More et non dans le rail direct", async () => {
    const onChangeView = vi.fn().mockResolvedValue(true);
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("desktop-nav-list")).toBeNull();

    const menu = openOverflowMenu();
    const listEntry = within(menu).getByTestId("desktop-nav-list");
    expect(listEntry).toHaveAccessibleName("List");

    fireEvent.click(listEntry);
    expect(onChangeView).toHaveBeenCalledWith("list");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("marque List comme destination active quand la vue courante est list", () => {
    render(<DesktopActionBar entries={entries()} activeId="list" tasks={[]} />);
    const menu = openOverflowMenu();
    const listEntry = within(menu).getByTestId("desktop-nav-list");
    expect(listEntry).toHaveAttribute("aria-current", "page");
    expect(listEntry).toHaveClass("desktop-action-bar__action--active");
  });

  it("rend une destination sur une seule rangée ascendante", () => {
    // FN-469 : Settings rejoindrait la liste, donc il est exclu pour que la rangée unique reste unique.
    const oneOverflowEntry = entries().filter((entry) => (entry.placement !== "overflow" || entry.id === "automations") && entry.id !== "settings");
    render(<DesktopActionBar entries={oneOverflowEntry} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(menu.querySelectorAll(":scope > .desktop-action-bar__action")).toHaveLength(1);
    expect(screen.getByTestId("desktop-nav-automations")).toHaveAccessibleName("Automations");
    expectAscendingSingleColumnGeometry(menu);
  });

  it("conserve en colonne l’ordre des entrées statiques, optionnelles et plugins, même avec deux libellés identiques", () => {
    const populatedEntries = entries(vi.fn(), {
      showSkills: true,
      flags: { memory: true, whiteboard: true, goals: true, insights: true, research: true, ideation: true, evals: true },
      pluginDashboardViews: [
        { pluginId: "plugin-later", view: { viewId: "shared", label: "Shared label", order: 2 } },
        { pluginId: "plugin-earlier", view: { viewId: "shared", label: "Shared label", order: 1 } },
      ],
    });
    // FN-469 : la composition du menu est `[...overflow, settings]`, Settings restant en dernier.
    const settingsEntry = populatedEntries.find((entry) => entry.id === "settings");
    const expectedOverflow = [...populatedEntries.filter((entry) => entry.placement === "overflow"), ...(settingsEntry ? [settingsEntry] : [])];
    render(<DesktopActionBar entries={populatedEntries} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    const renderedItems = Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .desktop-action-bar__action"));
    expect(renderedItems.map((item) => item.dataset.testid)).toEqual(expectedOverflow.map((entry) => entry.testId));
    expect(renderedItems.map((item) => item.getAttribute("aria-label"))).toEqual(expectedOverflow.map((entry) => entry.label));
    expect(screen.getAllByRole("button", { name: "Shared label" })).toHaveLength(2);
    expectAscendingSingleColumnGeometry(menu);
  });

  it("borne et fait défiler verticalement une longue liste sur une seule colonne", () => {
    const longEntries = entries(vi.fn(), {
      pluginDashboardViews: Array.from({ length: 30 }, (_, index) => ({
        pluginId: `plugin-${index}`,
        view: { viewId: "tool", label: `Plugin ${index}`, order: index },
      })),
    });
    // FN-469 : Settings est la dernière entrée composée du menu, donc il compte dans la liste bornée.
    const overflowCount = longEntries.filter((entry) => entry.placement === "overflow").length
      + (longEntries.some((entry) => entry.id === "settings") ? 1 : 0);
    render(<DesktopActionBar entries={longEntries} activeId="board" tasks={[]} />);
    const menu = openOverflowMenu();
    expect(menu.querySelectorAll(":scope > .desktop-action-bar__action")).toHaveLength(overflowCount);
    expectAscendingSingleColumnGeometry(menu);
  });

  it("limite la géométrie ascendante au footer Alpha desktop", () => {
    expect(alphaDesktopActionBarCss).not.toMatch(/(?:\.header|\.left-sidebar-nav|\.mobile-nav-bar)[^{]*\{[^}]*(?:grid-template-columns|grid-auto-flow|bottom:)/s);
    for (const standardNavigationCss of [headerCss, leftSidebarNavCss, mobileNavBarCss]) {
      expect(standardNavigationCss).not.toContain("desktop-action-bar__menu");
    }
  });

  it("conserve une traversée lente du gap puis ferme après une sortie complète", () => {
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const menu = screen.getByRole("menu");
    const perimeter = menu.parentElement!;
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerEnter(menu);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("annule le timer de fermeture au démontage", () => {
    vi.useFakeTimers();
    const view = render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    const infrastructureTimerCount = vi.getTimerCount();
    fireEvent.pointerLeave(screen.getByRole("menu").parentElement!);
    expect(vi.getTimerCount()).toBe(infrastructureTimerCount + 1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ouvre au focus ou au clic sans toggler, puis ferme avec Escape ou à la sortie du focus", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.focus(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.focus(trigger);
    const item = screen.getByTestId("desktop-nav-automations");
    fireEvent.blur(trigger, { relatedTarget: item });
    fireEvent.focus(item);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.focusOut(item, { relatedTarget: null });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("garde l’overflow ouvert quand la garde refuse puis le ferme après acceptation", async () => {
    const onChangeView = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    fireEvent.click(screen.getByTestId("desktop-nav-automations"));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("desktop-nav-automations"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onChangeView).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:PopoverLayering 2026-09-15-09:31:
  FN-413: while the More menu is open the footer must outrank every dashboard-managed window (shared stack at 10100+).
  The elevation is carried by the BAR because its `var(--z-sticky)` stacking context traps the absolutely positioned menu.
  */
  // (d)
  it("élève la barre au-dessus du plafond de fenêtres pendant l’ouverture du menu More", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const footer = screen.getByTestId("desktop-action-bar");
    expect(footer).not.toHaveClass("desktop-action-bar--menu-open");

    openOverflowMenu();
    expect(footer).toHaveClass("desktop-action-bar--menu-open");

    const openRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar--menu-open\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(openRule).toMatch(/z-index:\s*calc\(var\(--fusion-max-z\)\s*\+\s*3\)/);
    const restRule = alphaDesktopActionBarCss.match(/\.desktop-action-bar\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(restRule).toMatch(/z-index:\s*var\(--z-sticky\)/);
  });

  // (e)
  it("retire le modificateur d’élévation sur chaque fermeture existante", async () => {
    const onChangeView = vi.fn().mockResolvedValue(true);
    const view = render(<DesktopActionBar entries={entries(onChangeView)} activeId="board" tasks={[]} />);
    const footer = screen.getByTestId("desktop-action-bar");
    const trigger = screen.getByTestId("desktop-nav-more");

    // Escape
    fireEvent.focus(trigger);
    expect(footer).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(footer).not.toHaveClass("desktop-action-bar--menu-open");

    // sortie de focus
    fireEvent.focus(trigger);
    expect(footer).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.focusOut(trigger, { relatedTarget: null });
    expect(footer).not.toHaveClass("desktop-action-bar--menu-open");

    // sélection d’une entrée acceptée
    fireEvent.pointerEnter(trigger);
    expect(footer).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.click(screen.getByTestId("desktop-nav-automations"));
    await waitFor(() => expect(footer).not.toHaveClass("desktop-action-bar--menu-open"));

    view.unmount();

    // expiration du délai de grâce après pointerLeave
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const footer2 = screen.getByTestId("desktop-action-bar");
    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    expect(footer2).toHaveClass("desktop-action-bar--menu-open");
    fireEvent.pointerLeave(screen.getByRole("menu").parentElement!);
    act(() => vi.advanceTimersByTime(200));
    expect(footer2).not.toHaveClass("desktop-action-bar--menu-open");
  });

  // (i)
  it("ne rend ni conteneur overflow ni modificateur d’élévation sans destination overflow", () => {
    // FN-469 : le menu héberge aussi Settings, donc l'absence de conteneur se prouve sans aucune entrée à héberger.
    const withoutOverflow = entries().filter((entry) => entry.placement !== "overflow" && entry.id !== "settings");
    render(<DesktopActionBar entries={withoutOverflow} activeId="board" tasks={[]} />);
    expect(document.querySelector(".desktop-action-bar__more")).toBeNull();
    expect(screen.getByTestId("desktop-action-bar")).not.toHaveClass("desktop-action-bar--menu-open");
    expect(document.querySelector(".desktop-action-bar--menu-open")).toBeNull();
  });

  /*
  FNXC:DesktopNavigation 2026-09-15-19:42:
  FN-432: ouvrir n’appartient qu’au survol du bouton More. Le corridor invisible au-dessus du bouton ne doit pas capter le
  pointeur au repos, mais doit continuer d’empêcher la fermeture pendant la traversée bouton → liste.
  */
  // (a)
  it("n’ouvre pas au survol du périmètre seul et ouvre au survol de More", () => {
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    const perimeter = document.querySelector<HTMLElement>(".desktop-action-bar__more")!;

    fireEvent.pointerEnter(perimeter);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(perimeter).not.toHaveClass("desktop-action-bar__more--open");

    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(perimeter).toHaveClass("desktop-action-bar__more--open");
  });

  // (b)
  it("conserve le menu ouvert pendant la traversée du corridor vers la liste", () => {
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const menu = screen.getByRole("menu");
    const perimeter = menu.parentElement!;

    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerEnter(perimeter);
    fireEvent.pointerEnter(menu);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // (c)
  it("déclare un corridor inerte au repos et interactif seulement menu ouvert", () => {
    expect(overflowCorridorRule).toMatch(/pointer-events:\s*none/);
    expect(overflowCorridorRule).toMatch(/inset-inline:\s*0/);
    expect(overflowCorridorRule).toMatch(/bottom:\s*100%/);
    expect(overflowCorridorRule).toMatch(/block-size:\s*var\(--space-sm\)/);
    const openCorridorRule =
      alphaDesktopActionBarCss.match(/\.desktop-action-bar__more--open::before\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(openCorridorRule).toMatch(/pointer-events:\s*auto/);
  });

  // (d)
  it("ne rouvre pas depuis le périmètre seul après expiration de la grâce", () => {
    vi.useFakeTimers();
    render(<DesktopActionBar entries={entries()} activeId="board" tasks={[]} />);
    const trigger = screen.getByTestId("desktop-nav-more");
    fireEvent.pointerEnter(trigger);
    const perimeter = screen.getByRole("menu").parentElement!;
    fireEvent.pointerLeave(perimeter);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.pointerEnter(perimeter);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-more"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // (f) exemption mobile: la feuille More du téléphone reste au tap, sans périmètre de survol.
  it("n’introduit aucun survol d’ouverture dans la navigation mobile", () => {
    const mobileNavBarSource = readAppFile("components/MobileNavBar.tsx");
    expect(mobileNavBarSource).not.toMatch(/onPointerEnter/);
    expect(mobileNavBarSource).not.toMatch(/onMouseEnter/);
  });

  // (l) structural invariant: no footer ancestor may create a stacking context, or the elevation is trapped.
  it("garde les ancêtres de mise en page du footer sans contexte d’empilement", () => {
    const projectSelectorCss = readAppFile("components/ProjectSelector.css");
    for (const selector of [".dashboard-project-stack", ".dashboard-project-shell"]) {
      const rule = projectSelectorCss.match(
        new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`)
      )?.[1];
      expect(rule, `${selector} rule must exist`).toBeTruthy();
      const declarations = (rule ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const property of ["z-index", "transform", "filter", "contain", "isolation"]) {
        expect(declarations, `${selector} must not declare ${property}`).not.toMatch(
          new RegExp(`(^|[;{\\s])${property}\\s*:`)
        );
      }
    }
  });
});
