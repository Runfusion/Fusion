import { describe, expect, it } from "vitest";
import {
  agentActionsEnabled,
  getCompanionWebhookUrl,
  getFusionBaseUrl,
  getFusionToken,
  getNotifyColumns,
  getPollingIntervalMs,
  getQuickCaptureColumn,
} from "../settings.js";

describe("settings accessors", () => {
  it("uses safe defaults", () => {
    expect(getFusionBaseUrl({})).toBe("http://localhost:4040");
    expect(getFusionToken({})).toBeUndefined();
    expect(getCompanionWebhookUrl({})).toBeUndefined();
    expect(getPollingIntervalMs({})).toBe(30000);
    expect(getNotifyColumns({})).toEqual(["in-review"]);
    /*
    FNXC:PluginLifecycleColumns 2026-07-30-11:35: was `triage` — the column U11 (#2515)
    deleted from the default lineage, so quick capture defaulted every voice-captured card
    to a column the default board no longer declares. `todo` exists on both sides of that
    migration. These two cases are the reason the default is worth pinning at all: nothing
    else in the plugin fails when the default names a non-existent column — the server just
    rejects the create, at the far end of a voice interaction.
    */
    expect(getQuickCaptureColumn({})).toBe("todo");
    expect(agentActionsEnabled({})).toBe(true);
  });

  it("trims string values", () => {
    expect(getFusionBaseUrl({ fusionApiBaseUrl: "  http://fusion.local:4040  " })).toBe("http://fusion.local:4040");
    expect(getFusionToken({ fusionApiToken: "  token  " })).toBe("token");
    expect(getCompanionWebhookUrl({ companionWebhookUrl: "  https://companion.example/ingest  " })).toBe(
      "https://companion.example/ingest",
    );
  });

  it("enforces polling minimum and finite values", () => {
    expect(getPollingIntervalMs({ pollingIntervalSeconds: 2 })).toBe(5000);
    expect(getPollingIntervalMs({ pollingIntervalSeconds: 8.9 })).toBe(8000);
    expect(getPollingIntervalMs({ pollingIntervalSeconds: Number.NaN })).toBe(30000);
  });

  it("filters notify columns and falls back when invalid", () => {
    expect(getNotifyColumns({ notifyOnColumns: ["todo", " nope ", "in-review", 4] })).toEqual(["todo", "in-review"]);
    expect(getNotifyColumns({ notifyOnColumns: ["nope"] })).toEqual(["in-review"]);
  });

  it("validates quick capture column", () => {
    expect(getQuickCaptureColumn({ quickCaptureDefaultColumn: "done" })).toBe("done");
    expect(getQuickCaptureColumn({ quickCaptureDefaultColumn: "bad-column" })).toBe("todo");
  });

  it("respects explicit boolean for agent actions", () => {
    expect(agentActionsEnabled({ enableAgentActions: false })).toBe(false);
    expect(agentActionsEnabled({ enableAgentActions: true })).toBe(true);
    expect(agentActionsEnabled({ enableAgentActions: "true" })).toBe(true);
  });
});
