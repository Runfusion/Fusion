import { describe, expect, it, vi } from "vitest";
import { resolveNavigationQuickAccessEntryIds } from "../../../../core/src/board/mobile-nav-primary-items";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

const base = { view: "board" as const, onChangeView: vi.fn(), onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, showSkills: true, flags: { memory: true, whiteboard: true, goals: true, insights: true, research: true, ideation: true, evals: true } };

describe("dashboardNavigationEntries", () => {
  it("classe explicitement les destinations sans dupliquer History, Chat ou Notes", () => {
    const entries = buildDashboardNavigationEntries({ ...base, onOpenChatPanel: vi.fn() });
    expect(entries.every((entry) => ["main-page", "existing-action", "external-owner"].includes(entry.kind))).toBe(true);
    /*
     * FN-426: no destination may be owned by the right dock any more, because the dock is optional and default-off.
     * The `external-owner` tier is therefore empty, and the tools it used to declare are real destinations (Files,
     * Git, Dev Server) or sections of another owner (Pull Requests inside Git, Secrets inside Settings).
     */
    expect(entries.filter((entry) => entry.kind === "external-owner")).toEqual([]);
    expect(entries.some((entry) => entry.id === "secrets" || entry.id === "pull-requests")).toBe(false);
    /* FN-511 : `chat` est désormais une entrée ordinaire du registre (voir les cas dédiés ci-dessous) ; History et Notes restent hors registre. */
    expect(entries.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["patchnode", "notes"]));
    /*
     * FN-439 inverts FN-382's "List is a right-dock tool" assertion: List is a registry destination again, in the
     * overflow tier, so the footer **More** menu owns List on tablet/desktop.
     * FN-446: the direct rail is no longer hardcoded — it is the core-resolved quick-access default.
     * FN-511: that default is now FIVE configurable destinations ending in Chat, whose fifth slot the host renders in
     * the footer's right-hand track. Agents and Mailbox are deliberately not in the direct rail.
     */
    expect(entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["command-center", "board", "planning", "missions", "chat"]);
    expect(entries.some((entry) => entry.id === "list")).toBe(true);
    expect(entries.find((entry) => entry.id === "settings")?.placement).toBe("external");
    expect(entries.filter((entry) => entry.placement !== "external").every((entry) => typeof entry.onSelect === "function")).toBe(true);
  });

  /*
   * FN-446 : Agents quitte la rangée directe du pied de page par défaut mais reste une destination ordinaire du
   * registre — donc toujours rendue par la barre latérale (qui ne lit que `kind`) et par le menu **More**.
   */
  it("garde Agents comme destination overflow du registre, sans le retirer", () => {
    const entries = buildDashboardNavigationEntries(base);
    const agents = entries.find((entry) => entry.id === "agents");
    expect(agents).toBeDefined();
    expect(agents?.placement).toBe("overflow");
    expect(agents?.kind).toBe("main-page");
    expect(agents?.view).toBe("agents");
    expect(agents?.testId).toBe("desktop-nav-agents");
  });

  /*
   * FN-446 : la sélection persistée pilote l'ordre exact de la rangée directe, en traduisant les identifiants du
   * registre (`tasks` est déjà traduit en `board` par le core avant d'arriver ici).
   */
  it("respecte l'ordre exact de la sélection d'accès rapide", () => {
    const entries = buildDashboardNavigationEntries({ ...base, quickAccessEntryIds: ["mailbox", "agents", "board"] });
    expect(entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["mailbox", "agents", "board"]);
    expect(entries.find((entry) => entry.id === "command-center")?.placement).toBe("overflow");
    expect(entries.filter((entry) => entry.id === "mailbox")).toHaveLength(1);
  });

  /*
   * FN-511 : une sélection EXPLICITE de cinq destinations sans `chat` produit cinq entrées `direct` et renvoie le Chat
   * dans `overflow` (menu **More**) — exactement une fois, jamais les deux.
   */
  it("rend cinq destinations directes et renvoie le Chat en overflow quand il n'est pas sélectionné", () => {
    const entries = buildDashboardNavigationEntries({
      ...base,
      onOpenChatPanel: vi.fn(),
      quickAccessEntryIds: resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["command-center", "tasks", "missions", "mailbox", "planning"] }),
    });
    const direct = entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id);
    expect(direct).toEqual(["command-center", "board", "missions", "mailbox", "planning"]);
    expect(direct).toHaveLength(5);
    expect(entries.find((entry) => entry.id === "chat")?.placement).toBe("overflow");
    expect(entries.filter((entry) => entry.id === "chat")).toHaveLength(1);
  });

  /*
   * FN-511 : le Chat est une entrée ordinaire du registre, construite uniquement quand l'hôte fournit son ouverture.
   * Elle porte son contrat d'accessibilité de panneau via les champs génériques, et le registre en est l'unique
   * propriétaire : jamais deux entrées `chat`.
   */
  it("construit l'entrée Chat seulement quand onOpenChatPanel est fourni", () => {
    const onOpenChatPanel = vi.fn();
    const withChat = buildDashboardNavigationEntries({ ...base, onOpenChatPanel, chatHasUnreadResponse: true, chatPanelId: "chat-tool-panel" });
    const chat = withChat.find((entry) => entry.id === "chat");
    expect(chat).toBeDefined();
    expect(chat?.kind).toBe("existing-action");
    expect(chat?.testId).toBe("desktop-nav-chat-panel");
    expect(chat?.ariaHasPopup).toBe("dialog");
    expect(chat?.ariaExpanded).toBe(false);
    expect(chat?.ariaControls).toBeUndefined();
    expect(chat?.dot).toBe("pending");
    expect(chat?.active).toBeFalsy();
    chat?.onSelect?.();
    expect(onOpenChatPanel).toHaveBeenCalledTimes(1);

    const openChat = buildDashboardNavigationEntries({ ...base, onOpenChatPanel, chatHasUnreadResponse: true, chatPanelOpen: true, chatPanelId: "chat-tool-panel" }).find((entry) => entry.id === "chat");
    expect(openChat?.ariaExpanded).toBe(true);
    expect(openChat?.ariaControls).toBe("chat-tool-panel");
    expect(openChat?.active).toBe(true);
    expect(openChat?.dot).toBeUndefined();

    expect(buildDashboardNavigationEntries(base).some((entry) => entry.id === "chat")).toBe(false);
  });

  /*
   * FN-511 : cas de MISE À JOUR — une valeur persistée de quatre destinations sans `chat` est complétée par le core,
   * donc l'entrée Chat devient `direct` et ne réapparaît pas dans le menu.
   */
  it("classe le Chat en direct pour une sélection héritée de quatre destinations", () => {
    const entries = buildDashboardNavigationEntries({
      ...base,
      onOpenChatPanel: vi.fn(),
      quickAccessEntryIds: resolveNavigationQuickAccessEntryIds({ mobileNavPrimaryItems: ["command-center", "tasks", "planning", "missions"] }),
    });
    const direct = entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id);
    expect(direct).toEqual(["command-center", "board", "planning", "missions", "chat"]);
    expect(entries.filter((entry) => entry.id === "chat")).toHaveLength(1);
  });

  /* FN-446 : une destination sélectionnée mais désactivée par son gate est simplement absente, sans trou ni coquille. */
  it("ignore une destination sélectionnée mais gatée off", () => {
    const entries = buildDashboardNavigationEntries({ ...base, showAgents: false, quickAccessEntryIds: ["board", "agents", "mailbox"] });
    expect(entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["board", "mailbox"]);
    expect(entries.some((entry) => entry.id === "agents")).toBe(false);
  });

  /* FN-446 : sélection vide, identifiants inconnus et doublons ne peuvent ni vider ni dupliquer la rangée directe. */
  it("traite les sélections vides, inconnues et dupliquées sans coquille vide", () => {
    const emptySelection = buildDashboardNavigationEntries({ ...base, quickAccessEntryIds: [] });
    expect(emptySelection.filter((entry) => entry.placement === "direct")).toEqual([]);
    expect(emptySelection.filter((entry) => entry.placement === "overflow").length).toBeGreaterThan(0);

    const unknownSelection = buildDashboardNavigationEntries({ ...base, quickAccessEntryIds: ["nope", "board", "board"] });
    expect(unknownSelection.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["board"]);
    expect(unknownSelection.filter((entry) => entry.id === "board")).toHaveLength(1);
  });

  /*
   * FN-439 cas (f) : List quitte le Header sur tablette/ordinateur, donc le registre doit en porter la destination de
   * remplacement — placement `overflow` (menu **More** du pied de page), route `list`, testId `desktop-nav-list`.
   */
  it("expose List comme destination overflow routée vers la vue list", () => {
    const onChangeView = vi.fn();
    const entries = buildDashboardNavigationEntries({ ...base, onChangeView });
    const list = entries.find((entry) => entry.id === "list");
    expect(list).toBeDefined();
    expect(list?.placement).toBe("overflow");
    expect(list?.kind).toBe("main-page");
    expect(list?.view).toBe("list");
    expect(list?.testId).toBe("desktop-nav-list");
    list?.onSelect?.();
    expect(onChangeView).toHaveBeenCalledWith("list");
  });

  /* FN-426: Files and Git are ordinary destinations that navigate through the shared view owner, like any other page. */
  it("offre Files et Git comme destinations principales routées par onChangeView", () => {
    const onChangeView = vi.fn();
    const entries = buildDashboardNavigationEntries({ ...base, onChangeView, showDevServer: true });
    const files = entries.find((entry) => entry.id === "files");
    const git = entries.find((entry) => entry.id === "git-manager");
    expect(files?.kind).toBe("main-page");
    expect(files?.view).toBe("files");
    expect(git?.kind).toBe("main-page");
    expect(git?.view).toBe("git-manager");
    files?.onSelect?.();
    git?.onSelect?.();
    expect(onChangeView).toHaveBeenNthCalledWith(1, "files");
    expect(onChangeView).toHaveBeenNthCalledWith(2, "git-manager");
    expect(entries.some((entry) => entry.id === "dev-server")).toBe(true);
  });

  /*
   * FN-480 cas (f) : contrôle négatif hors mobile. Le remappage « Board = List » est une décision de rendu de l'hôte
   * mobile uniquement ; il ne doit pas fuir dans ce registre partagé, où `board` et `list` restent deux destinations
   * distinctes routant chacune vers sa propre vue.
   */
  it("garde Board et List comme destinations distinctes dans le registre partagé", () => {
    const onChangeView = vi.fn();
    const entries = buildDashboardNavigationEntries({ ...base, onChangeView, quickAccessEntryIds: ["board"] });
    const board = entries.find((entry) => entry.id === "board");
    const list = entries.find((entry) => entry.id === "list");

    expect(board?.view).toBe("board");
    expect(board?.testId).toBe("desktop-nav-board");
    expect(board?.placement).toBe("direct");
    expect(list?.view).toBe("list");
    expect(list?.testId).toBe("desktop-nav-list");

    board?.onSelect?.();
    expect(onChangeView).toHaveBeenNthCalledWith(1, "board");
    list?.onSelect?.();
    expect(onChangeView).toHaveBeenNthCalledWith(2, "list");
  });

  it("conserve les gates et route chaque catégorie vers son propriétaire", async () => {
    const entries = buildDashboardNavigationEntries({ ...base, showAgents: false, showSkills: false, flags: {} });
    expect(entries.some((entry) => entry.id === "agents" || entry.id === "skills" || entry.id === "memory")).toBe(false);
    /* FN-426: Dev Server stays gated by its experimental flag, now in primary navigation instead of the dock. */
    expect(entries.some((entry) => entry.id === "dev-server")).toBe(false);
    entries.find((entry) => entry.id === "planning")?.onSelect?.();
    expect(entries.find((entry) => entry.id === "new-task")).toBeUndefined();
    expect(base.onChangeView).toHaveBeenCalledWith("planning");
    expect(base.onNewTask).not.toHaveBeenCalled();
  });
});
