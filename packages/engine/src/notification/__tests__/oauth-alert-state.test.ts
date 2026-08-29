import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthAlertStateStore } from "../oauth-alert-state.js";

const tempDirs: string[] = [];

function createTempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "oauth-alert-state-"));
  tempDirs.push(dir);
  return join(dir, "oauth-alert-state.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("OAuthAlertStateStore", () => {
  it("round-trips provider alert state using the configured path", () => {
    const statePath = createTempStatePath();
    const store = new OAuthAlertStateStore({ statePath, clock: () => 1234 });

    store.recordAlert("openai-codex", 9999);

    const reloaded = new OAuthAlertStateStore({ statePath });
    expect(reloaded.get("openai-codex")).toEqual({ expires: 9999, lastAlertAt: 1234 });
  });

  it("returns empty state when the file is missing or corrupt", () => {
    const missingPath = createTempStatePath();
    const missingStore = new OAuthAlertStateStore({ statePath: missingPath });
    expect(missingStore.get("openai-codex")).toBeUndefined();

    const corruptPath = createTempStatePath();
    writeFileSync(corruptPath, "{not json", "utf-8");
    const corruptStore = new OAuthAlertStateStore({ statePath: corruptPath });
    expect(corruptStore.get("openai-codex")).toBeUndefined();
  });

  it("persists only provider ids with expires and lastAlertAt", () => {
    const statePath = createTempStatePath();
    const store = new OAuthAlertStateStore({ statePath, clock: () => 5678 });

    store.recordAlert("claude", 4321);

    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({
      claude: {
        expires: 4321,
        lastAlertAt: 5678,
      },
    });
  });

  it("clears selected providers and all providers", () => {
    const statePath = createTempStatePath();
    const store = new OAuthAlertStateStore({ statePath, clock: () => 100 });

    store.recordAlert("claude", 1_000);
    store.recordAlert("openai-codex", 2_000, 200);
    store.clear(["claude"]);

    const afterSingleClear = new OAuthAlertStateStore({ statePath });
    expect(afterSingleClear.get("claude")).toBeUndefined();
    expect(afterSingleClear.get("openai-codex")).toEqual({ expires: 2_000, lastAlertAt: 200 });

    afterSingleClear.clear();
    expect(new OAuthAlertStateStore({ statePath }).get("openai-codex")).toBeUndefined();
  });
});
