// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  diffSettingsForActivity,
  formatSettingsActivity,
  isSensitiveSettingsKey,
  summarizeSettingsValue,
} from "../task-store/settings-activity.js";
import { setupActivityLogListenersImpl } from "../task-store/lifecycle-ops.js";

type ActivityEntry = {
  type: string;
  details: string;
  metadata?: Record<string, unknown>;
};

function wireSettingsListener() {
  const events = new EventEmitter();
  const rows: ActivityEntry[] = [];
  const store = {
    activityListenersWired: false,
    on: events.on.bind(events),
    recordActivityFromListener: vi.fn((entry: ActivityEntry) => rows.push(entry)),
  };

  setupActivityLogListenersImpl(store as never);
  return {
    emit: (settings: object, previous: object) => events.emit("settings:updated", { settings, previous }),
    rows,
  };
}

describe("settings activity formatting", () => {
  it("ignores no-op and engine-churn-only updates", () => {
    expect(diffSettingsForActivity({ autoMerge: true }, { autoMerge: true })).toEqual([]);
    expect(diffSettingsForActivity(
      { engineLastActiveAt: "before", engineActiveSinceMs: 1 },
      { engineLastActiveAt: "after", engineActiveSinceMs: 2 },
    )).toEqual([]);
    expect(formatSettingsActivity([])).toBeNull();
  });

  it("renders additions, removals, nested values, and long strings safely", () => {
    const changes = diffSettingsForActivity(
      { removed: "value", nested: { one: true }, longValue: "short" },
      { added: "value", nested: { one: false }, longValue: " x".repeat(50) },
    );
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "added", from: "unset", to: "value" }),
      expect.objectContaining({ key: "removed", from: "value", to: "unset" }),
      expect.objectContaining({ key: "nested", from: "{…}", to: "{…}" }),
    ]));
    expect(changes.find((change) => change.key === "longValue")?.to).toHaveLength(81);
  });

  it("uses stable deep equality for unchanged nested settings", () => {
    expect(diffSettingsForActivity(
      { modelPresets: [{ id: "default", options: { enabled: true } }], experimentalFeatures: { alpha: true } },
      { experimentalFeatures: { alpha: true }, modelPresets: [{ options: { enabled: true }, id: "default" }] },
    )).toEqual([]);
  });

  it("redacts every secret-bearing setting value", () => {
    const sensitiveKeys = [
      "ntfyAccessToken",
      "gitlabAuthToken",
      "githubAuthToken",
      "daemonToken",
      "researchGlobalBraveApiKey",
      "researchGlobalGoogleSearchApiKey",
      "researchGlobalTavilyApiKey",
    ];
    for (const key of sensitiveKeys) {
      expect(isSensitiveSettingsKey(key)).toBe(true);
      const [change] = diffSettingsForActivity({ [key]: "old-secret" }, { [key]: "new-secret" });
      expect(change).toMatchObject({ from: "«redacted»", to: "«redacted»", sensitive: true });
    }
    expect(summarizeSettingsValue("plainValue", null)).toBe("unset");
  });

  it("caps displayed and metadata changes while retaining the total", () => {
    const previous = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key${index}`, false]));
    const next = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`key${index}`, true]));
    const activity = formatSettingsActivity(diffSettingsForActivity(previous, next));
    expect(activity?.details).toContain("+2 more");
    expect(activity?.metadata).toMatchObject({ changedCount: 10 });
    expect(activity?.metadata?.changes).toHaveLength(10);
  });
});

describe("settings:updated activity listener", () => {
  it.each([
    ["autoMerge", true, false],
    ["mergeStrategy", "direct", "pull-request"],
    ["maxAutoMergeRetries", 3, 4],
    ["integrationBranch", "main", "release"],
    ["ntfyEnabled", true, false],
    ["ntfyTopic", "old", "new"],
    ["globalPause", true, false],
    ["enginePaused", true, false],
  ])("records each operator-visible %s setting change", (key, before, after) => {
    const listener = wireSettingsListener();
    listener.emit({ [key]: after }, { [key]: before });
    expect(listener.rows).toHaveLength(1);
    expect(listener.rows[0]).toMatchObject({ type: "settings:updated" });
    expect(listener.rows[0].details).toContain(key);
    expect(listener.rows[0].details).toContain(summarizeSettingsValue(key, before));
    expect(listener.rows[0].details).toContain(summarizeSettingsValue(key, after));
  });

  it("omits churn, retains real settings in mixed updates, and ignores rollback no-ops", () => {
    const listener = wireSettingsListener();
    listener.emit({ engineLastActiveAt: "after" }, { engineLastActiveAt: "before" });
    listener.emit({ engineActiveSinceMs: 2 }, { engineActiveSinceMs: 1 });
    listener.emit({ engineLastActiveAt: "after", autoMerge: false }, { engineLastActiveAt: "before", autoMerge: true });
    listener.emit({ modelPresets: [{ id: "default" }] }, { modelPresets: [{ id: "default" }] });

    expect(listener.rows).toHaveLength(1);
    expect(listener.rows[0].details).toContain("autoMerge");
    expect(listener.rows[0].details).not.toContain("engineLastActiveAt");
  });

  it("never records secret values in details or metadata", () => {
    const listener = wireSettingsListener();
    listener.emit(
      { ntfyAccessToken: "new-ntfy-secret", githubAuthToken: "new-github-secret" },
      { ntfyAccessToken: "old-ntfy-secret", githubAuthToken: "old-github-secret" },
    );

    expect(listener.rows).toHaveLength(1);
    expect(JSON.stringify(listener.rows[0])).not.toContain("old-ntfy-secret");
    expect(JSON.stringify(listener.rows[0])).not.toContain("new-ntfy-secret");
    expect(JSON.stringify(listener.rows[0])).not.toContain("old-github-secret");
    expect(JSON.stringify(listener.rows[0])).not.toContain("new-github-secret");
  });
});
