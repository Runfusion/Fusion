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

  /*
  FNXC:PluginLifecycleColumns 2026-07-30-23:40:
  THE INVARIANT: a lane name the operator typed is theirs to choose, not ours to veto.

  These two cases previously asserted the opposite — that a column outside the legacy five is
  "invalid" and gets replaced. That assumption dates to the plugin's original commits (FN-3738 /
  FN-3970), when the five ids WERE the whole vocabulary; it is not a deliberate contract anyone
  defended later, and it is now the defect: `notifyOnColumns` is a free-text array, so an operator on
  a renamed board types `checking`, it is filtered to nothing, and the fallback `in-review` matches no
  card — notifications silently never fire while the setting looks configured.

  Structural rejection is still asserted, because that part was always right: non-strings, blanks and
  whitespace-only entries are not lane names. What is gone is rejection on VOCABULARY.

  Reverted, the first two expectations below fail — `["checking","shipped"]` comes back as
  `["in-review"]`, and `backlog` comes back as `todo`.
  */
  it("keeps the operator's own lane names instead of substituting a legacy fallback", () => {
    expect(getNotifyColumns({ notifyOnColumns: ["checking", "shipped"] })).toEqual(["checking", "shipped"]);
    expect(getQuickCaptureColumn({ quickCaptureDefaultColumn: "backlog" })).toBe("backlog");
  });

  it("still rejects entries that are not lane names at all, and still trims", () => {
    expect(getNotifyColumns({ notifyOnColumns: ["todo", " spaced ", "", "   ", 4] })).toEqual(["todo", "spaced"]);
    expect(getNotifyColumns({ notifyOnColumns: [] })).toEqual(["in-review"]);
    expect(getNotifyColumns({ notifyOnColumns: "not-an-array" })).toEqual(["in-review"]);
    expect(getQuickCaptureColumn({ quickCaptureDefaultColumn: "   " })).toBe("todo");
  });

  it("still accepts the legacy ids", () => {
    expect(getNotifyColumns({ notifyOnColumns: ["todo", "in-review"] })).toEqual(["todo", "in-review"]);
    expect(getQuickCaptureColumn({ quickCaptureDefaultColumn: "done" })).toBe("done");
  });

  it("respects explicit boolean for agent actions", () => {
    expect(agentActionsEnabled({ enableAgentActions: false })).toBe(false);
    expect(agentActionsEnabled({ enableAgentActions: true })).toBe(true);
    expect(agentActionsEnabled({ enableAgentActions: "true" })).toBe(true);
  });
});
