import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(process.cwd(), "app");

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "__tests__", "__mocks__"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && path.endsWith(".tsx")) yield path;
  }
}

describe("ChatView pop-out host inventory", () => {
  /*
  FNXC:ChatWindows 2026-08-23-03:33:
  FN-169 uses this source census to prevent a new ChatView host from silently omitting the
  pop-out trigger. The menu remains owned by ChatView rather than being duplicated by a host.
  */
  it("keeps all production ChatView hosts wired to the pop-out trigger", () => {
    const mounts = [...walk(appRoot)].filter((file) => readFileSync(file, "utf8").includes("<ChatView"))
      .map((file) => relative(appRoot, file).replaceAll("\\", "/")).sort();
    expect(mounts).toEqual(["App.tsx", "components/PoppedOutChatWindows.tsx", "components/dashboard/MainContent.tsx", "components/overflowViewRegistry.tsx"]);
    for (const file of mounts) expect(readFileSync(join(appRoot, file), "utf8")).toContain("onOpenSessionInNewWindow");

    const popOut = readFileSync(join(appRoot, "components/PoppedOutChatWindows.tsx"), "utf8");
    expect(popOut).toContain("initialDirectSession={entry.session}");
    expect(popOut).toContain("initialDirectSessionNonce={entry.focusNonce}");
    expect(popOut).toContain("raiseToFrontSignal={entry.focusNonce}");
    expect(popOut).toContain("cascadeOffsetIndex={entry.cascadeSlot + 1}");
    const chatView = readFileSync(join(appRoot, "components/ChatView.tsx"), "utf8");
    const affordanceFiles = [...walk(appRoot)].filter((file) => readFileSync(file, "utf8").includes("chat-context-open-window"));
    expect(affordanceFiles.map((file) => relative(appRoot, file).replaceAll("\\", "/"))).toEqual(["components/ChatView.tsx"]);

    /*
    FNXC:ChatWindows 2026-08-27-09:23:
    The empty-state New Chat button cannot coexist with a selected detail pane, so its modifier path is covered structurally here rather than with an impossible duplicate render state.
    */
    for (const testId of ["chat-new-btn", "chat-new-btn-empty"]) {
      const testIdPosition = chatView.indexOf(`data-testid="${testId}"`);
      expect(testIdPosition).toBeGreaterThanOrEqual(0);
      const buttonStart = chatView.lastIndexOf("<button", testIdPosition);
      expect(chatView.slice(buttonStart, testIdPosition)).toContain("onClick={handleNewChat}");
    }
  });
});
