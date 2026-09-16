import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SnippetsView } from "../SnippetsView";
import * as apiModule from "../../api";
import type { ChatSnippet, GlobalSettings, Settings } from "@fusion/core";
import { __test_resetChatSnippetsCache } from "../../hooks/useChatSnippetsCache";

vi.mock("../../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const mockFetchGlobalSettings = vi.mocked(apiModule.fetchGlobalSettings);
const mockUpdateGlobalSettings = vi.mocked(apiModule.updateGlobalSettings);

/*
FNXC:SnippetsDestination 2026-09-16-21:44:
FN-476: the view has no refresh control, so a remote change is delivered by the shared SSE bus. The bus is replaced by
this capture so the suite can drive the real subscription the cache opens — one handler for the snippets event and one
reconnect path — without opening a network connection.
*/
const sseHandlers: { events: Record<string, (event: MessageEvent) => void>; onReconnect?: () => void }[] = [];
vi.mock("../../sse-bus", () => ({
  subscribeSse: (_url: string, sub: { events?: Record<string, (event: MessageEvent) => void>; onReconnect?: () => void }) => {
    const entry = { events: sub.events ?? {}, onReconnect: sub.onReconnect };
    sseHandlers.push(entry);
    return () => {
      const index = sseHandlers.indexOf(entry);
      if (index >= 0) sseHandlers.splice(index, 1);
    };
  },
}));

function emitSnippetsUpdated(): void {
  for (const entry of [...sseHandlers]) {
    entry.events["settings:chat-snippets-updated"]?.(new MessageEvent("message", { data: "{}" }));
  }
}

/*
Snippets left SkillsView for its own destination. Every behaviour below used to run inside the Skills tab bar and is
asserted here against the standalone view: same cache, same validation, same mutation contracts, no tab to activate.
*/
describe("SnippetsView", () => {
  let chatSnippets: ChatSnippet[];

  beforeEach(() => {
    __test_resetChatSnippetsCache();
    vi.clearAllMocks();
    sseHandlers.length = 0;
    chatSnippets = [];
    mockFetchGlobalSettings.mockImplementation(async () => ({ chatSnippets: chatSnippets.map((snippet) => ({ ...snippet })) }));
    mockUpdateGlobalSettings.mockImplementation(async (patch: Partial<GlobalSettings>) => {
      chatSnippets = (patch.chatSnippets ?? []).map((snippet) => ({ ...snippet }));
      return { chatSnippets: chatSnippets.map((snippet) => ({ ...snippet })) } as Settings;
    });
  });

  it("composes the standard collection shape: header, rail of saved snippets, editor", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    const { container } = render(<SnippetsView />);
    await screen.findByText("/existing");

    const layout = container.querySelector(".view-layout")!;
    expect(layout.querySelector(".view-header")).toBeTruthy();
    // The saved snippets are the sidebar rail, not a block inside the content pane.
    const rail = container.querySelector("[data-testid='snippets-list']")!;
    expect(rail).toBeTruthy();
    expect(rail.closest(".view-layout__sidebar-slot")).toBeTruthy();
    expect(rail.querySelector("[data-testid='snippets-item-existing']")).toBeTruthy();
    // The editor owns the main panel.
    const editor = container.querySelector(".view-layout__content .snippets-view__editor")!;
    expect(editor).toBeTruthy();
    expect(editor.querySelector("form")).toBeTruthy();
  });

  it("creates, edits, and deletes a snippet while preserving prompt text", async () => {
    render(<SnippetsView />);
    await screen.findByTestId("snippets-empty");

    const prompt = "  lance toujours les tests\navec chrome devtool mcp 😀  ";
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  ＴＥＳＴ  " } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: prompt } });
    fireEvent.click(screen.getByRole("button", { name: "Add snippet" }));

    await screen.findByText("/test");
    expect(mockUpdateGlobalSettings).toHaveBeenLastCalledWith({
      chatSnippets: [{ name: "test", prompt }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit /test" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "checks" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: `${prompt}\nupdated` } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const renamedTrigger = await screen.findByText("/checks");
    expect(renamedTrigger.closest("article")?.querySelector(".skills-view-snippets__preview")?.textContent).toBe(`${prompt}\nupdated`);
    fireEvent.click(screen.getByRole("button", { name: "Delete /checks" }));
    await screen.findByTestId("snippets-empty");
    expect(screen.queryByText("/checks")).toBeNull();
  });

  it("rejects reserved, duplicate, and over-capacity names before writing", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    const first = render(<SnippetsView />);
    await screen.findByText("/existing");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "STEER" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Add snippet" }));
    expect(await screen.findByText("This name is reserved for a chat command.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ＥＸＩＳＴＩＮＧ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add snippet" }));
    expect(await screen.findByText("A snippet with this name already exists.")).toBeTruthy();
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();

    first.unmount();
    __test_resetChatSnippetsCache();
    chatSnippets = Array.from({ length: 50 }, (_, index) => ({ name: `item-${index}`, prompt: `${index}` }));
    render(<SnippetsView />);
    await screen.findByText("/item-49");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "overflow" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Add snippet" }));
    expect(await screen.findByText("You can save up to 50 snippets.")).toBeTruthy();
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("keeps the loaded list and editable form after a failed write rebase", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("write failed"));
    render(<SnippetsView />);
    await screen.findByText("/existing");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "keep editable" } });
    fireEvent.click(screen.getByRole("button", { name: "Add snippet" }));

    expect(await screen.findByText("The snippet could not be saved. Try again.")).toBeTruthy();
    expect(screen.getByText("/existing")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("test");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("keep editable");
  });

  it("disables writes before the first authoritative load and exposes retry after failure", async () => {
    let rejectLoad!: (error: Error) => void;
    mockFetchGlobalSettings.mockReturnValueOnce(new Promise((_, reject) => { rejectLoad = reject; }));
    render(<SnippetsView />);

    expect(screen.getByTestId("snippets-loading")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add snippet" })).toBeDisabled();
    await act(async () => rejectLoad(new Error("read failed")));
    expect(await screen.findByText("Snippets could not be refreshed. Your last loaded list is still shown.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add snippet" })).toBeDisabled();
    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("leaves no empty shells, duplicate landmark ids, or unnamed controls", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    const { container } = render(<SnippetsView />);
    await screen.findByText("/existing");

    // No skills chrome survives in this destination.
    expect(container.querySelector("[data-testid='skills-tab-skills']")).toBeNull();
    expect(container.querySelector("[data-testid='skills-tab-snippets']")).toBeNull();
    expect(container.querySelector("[role='tablist']")).toBeNull();

    const ids = Array.from(container.querySelectorAll("[id]")).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const control of Array.from(container.querySelectorAll("button"))) {
      const name = control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "";
      expect(name.length).toBeGreaterThan(0);
    }
  });

  /*
  FNXC:SnippetsDestination 2026-09-16-21:44:
  FN-476 REPLACES the previous "closes through its owner" case. Snippets is a destination reached by navigation, so a
  close cross and a manual refresh are window chrome it must not carry; leaving that test in place would have required
  re-adding the removed affordance to satisfy it. The view keeps its title, its count, its New action, and the Retry
  that belongs to the error state.
  */
  it("ne porte ni Fermer ni Actualiser dans son en-tête, en bureau comme en téléphone", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    const { container } = render(<SnippetsView />);
    await screen.findByText("/existing");

    const header = container.querySelector(".view-header") as HTMLElement;
    expect(screen.queryByTestId("snippets-refresh")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh snippets" })).toBeNull();
    // Aucun shell vide ni label orphelin ne subsiste après le retrait des deux commandes.
    for (const control of Array.from(header.querySelectorAll("button"))) {
      const name = control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "";
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toBe("×");
    }
    expect(header.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByTestId("snippets-new")).toBeTruthy();
    expect(screen.getByTestId("snippets-count")).toBeTruthy();
  });

  it("reflète une création, une modification et une suppression distantes sans aucun clic", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    render(<SnippetsView />);
    await screen.findByText("/existing");

    chatSnippets = [{ name: "existing", prompt: "existing prompt" }, { name: "remote", prompt: "remote prompt" }];
    await act(async () => { emitSnippetsUpdated(); });
    expect(await screen.findByText("/remote")).toBeTruthy();

    chatSnippets = [{ name: "existing", prompt: "existing prompt" }, { name: "renamed", prompt: "remote prompt" }];
    await act(async () => { emitSnippetsUpdated(); });
    expect(await screen.findByText("/renamed")).toBeTruthy();
    expect(screen.queryByText("/remote")).toBeNull();

    chatSnippets = [];
    await act(async () => { emitSnippetsUpdated(); });
    expect(await screen.findByTestId("snippets-empty")).toBeTruthy();
  });

  it("n'écrase pas un brouillon saisi caractère par caractère lors d'une actualisation distante", async () => {
    chatSnippets = [{ name: "existing", prompt: "existing prompt" }];
    render(<SnippetsView />);
    await screen.findByText("/existing");

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    for (const char of "draft") {
      fireEvent.change(name, { target: { value: name.value + char } });
    }
    fireEvent.change(prompt, { target: { value: "texte en cours" } });
    name.focus();

    chatSnippets = [{ name: "existing", prompt: "existing prompt" }, { name: "remote", prompt: "remote prompt" }];
    await act(async () => { emitSnippetsUpdated(); });
    expect(await screen.findByText("/remote")).toBeTruthy();

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("draft");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("texte en cours");
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });
});
